import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkLimits, formatUsd, percentChange, summarizeCost } from "../src/domain/limits.ts";
import { failureKind } from "../src/domain/checks.ts";
import { parseCaseFile, type EvalCase } from "../src/domain/case.ts";
import { compareReports, toBaseline } from "../src/domain/baseline.ts";
import { functionTarget, httpTarget } from "../src/adapters/http-target.ts";
import { jsonlTarget } from "../src/adapters/jsonl-target.ts";
import { runEval } from "../src/app/run.ts";
import { toMarkdown } from "../src/app/markdown.ts";
import type { TargetResponse } from "../src/ports.ts";
import { fakeServer, json } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src/cli/main.ts");
const INDEX = pathToFileURL(join(ROOT, "src/index.ts")).href;

const ask = (id: string): EvalCase => ({ id, question: `question ${id}`, locale: "en" });
/** A target that answers every case with the same response (cost and time included). */
const fixed = (r: Omit<TargetResponse, "answer">) => functionTarget("fake", () => Promise.resolve({ answer: "Fine.", ...r }));

test("formatUsd and percentChange", () => {
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(0.000412), "$0.000412");
  assert.equal(formatUsd(0.0123), "$0.0123");
  assert.equal(formatUsd(0.45), "$0.450");
  assert.equal(formatUsd(1.2), "$1.20");
  assert.equal(percentChange(0.001, 0.0015), 50);
  assert.equal(percentChange(200, 190), -5);
  assert.equal(percentChange(0, 1), null, "no percent from zero");
  assert.equal(percentChange(undefined, 1), null);
});

test("acceptance 8: maxCostUsd fails an answer that cost more; without costUsd the limit is not checked", async () => {
  const c = { ...ask("a"), maxCostUsd: 0.01 };
  assert.deepEqual(checkLimits(c, { costUsd: 0.02, ms: 10 }), {
    failures: [{ code: "over-cost", detail: "$0.0200 > $0.0100" }],
    notChecked: [],
  });
  assert.deepEqual(checkLimits(c, { costUsd: 0.01, ms: 10 }).failures, [], "at the limit passes");
  assert.deepEqual(checkLimits(c, { ms: 10 }), { failures: [], notChecked: ["cost"] });
  assert.equal(failureKind("over-cost"), "usefulness");

  const over = await runEval({ target: fixed({ costUsd: 0.02 }), cases: [c] });
  assert.equal(over.cases[0]?.passed, false);
  assert.deepEqual(
    over.cases[0]?.failures.map((f) => f.code),
    ["over-cost"],
  );

  const unknown = await runEval({ target: fixed({}), cases: [c] });
  assert.equal(unknown.cases[0]?.passed, true, "not checked is not a failure");
  assert.deepEqual(unknown.cases[0]?.notChecked, ["cost"]);
  assert.deepEqual(unknown.notChecked, { cost: ["a"], latency: [] });
  assert.match(toMarkdown(unknown), /Limits not checked: cost on 1 case\(s\), no costUsd reported: a\./);
});

test("maxLatencyMs on the target's own clock; an untimed answer is not checked; the case limit wins", async () => {
  assert.deepEqual(checkLimits(ask("a"), { ms: 900 }, { maxLatencyMs: 500 }).failures, [
    { code: "over-latency", detail: "900 ms > 500 ms" },
  ]);
  assert.deepEqual(checkLimits({ ...ask("a"), maxLatencyMs: 1000 }, { ms: 900 }, { maxLatencyMs: 500 }).failures, []);
  assert.deepEqual(checkLimits(ask("a"), { ms: null }, { maxLatencyMs: 500 }).notChecked, ["latency"]);
  assert.equal(failureKind("over-latency"), "usefulness");
  const report = await runEval({ target: fixed({ ms: 900 }), cases: [ask("a")], checks: { maxLatencyMs: 500 } });
  assert.equal(report.cases[0]?.ms, 900);
  assert.deepEqual(
    report.cases[0]?.failures.map((f) => f.code),
    ["over-latency"],
  );
});

test("with repeat, every attempt is checked and over-cost is weighed against minPassRate", async () => {
  const costs = [0.001, 0.001, 0.05, 0.001];
  let i = 0;
  const target = functionTarget("fake", () => Promise.resolve({ answer: "Fine.", costUsd: costs[i++] ?? 0 }));
  const report = await runEval({ target, cases: [ask("a")], checks: { maxCostUsd: 0.01 }, repeat: 4, minPassRate: 0.75 });
  assert.equal(report.cases[0]?.passRate, 0.75);
  assert.equal(report.cases[0]?.passed, true);
  assert.deepEqual(
    report.cost,
    { answers: 4, notReported: 0, totalUsd: 0.053, meanUsd: 0.01325, p90Usd: 0.05 },
    "total is what the run spent",
  );
});

test("cost summary: answers without a cost are counted, never free; p95 latency in the report", async () => {
  assert.equal(summarizeCost([undefined, undefined]), null);
  assert.deepEqual(summarizeCost([0.002, undefined, 0.004]), {
    answers: 2,
    notReported: 1,
    totalUsd: 0.006,
    meanUsd: 0.003,
    p90Usd: 0.004,
  });
  let n = 0;
  const target = functionTarget("fake", () => Promise.resolve({ answer: "Fine.", ms: 100 * ++n, ...(n === 2 ? {} : { costUsd: 0.002 }) }));
  const report = await runEval({ target, cases: ["a", "b", "c"].map(ask) });
  assert.deepEqual(report.latencyMs, { p50: 200, p90: 300, p95: 300 });
  assert.equal(report.cost?.notReported, 1);
  const md = toMarkdown(report);
  assert.match(md, /latency p50 200 ms · p90 300 ms · p95 300 ms/);
  assert.match(md, /Cost: total \$0\.00400 · mean \$0\.00200 · p90 \$0\.00200 per answer \(1 answer without a cost\)\./);
});

test("a malformed cost is an error, a bad limit stops the run, and case limits are validated", async () => {
  const bad = await runEval({ target: fixed({ costUsd: -1 }), cases: [ask("a")] });
  assert.deepEqual(bad.cases[0]?.failures, [{ code: "error", detail: "costUsd must be a number, 0 or more (got -1)" }]);
  await assert.rejects(runEval({ target: fixed({}), cases: [ask("a")], checks: { maxCostUsd: -0.1 } }), /checks.maxCostUsd must be/);
  assert.throws(() => parseCaseFile([{ ...ask("a"), maxCostUsd: "cheap" }]), /"maxCostUsd" must be a number, 0 or more/);
  assert.throws(() => parseCaseFile([{ ...ask("a"), maxLatencyMs: -5 }]), /"maxLatencyMs" must be a number, 0 or more/);
});

test("httpTarget reads costPath and msPath; a value that isn't a number is an error", async () => {
  const s = await fakeServer((body, _req, res) => {
    if (body.question === "bad") return json(res, { answer: "x", usage: { cost: "free" } });
    json(res, { answer: "Fine.", usage: { cost: 0.0031 }, timing: { app_ms: 640 } });
  });
  try {
    const t = httpTarget({ url: s.url, answerPath: "answer", costPath: "usage.cost", msPath: "timing.app_ms" });
    assert.deepEqual(await t.ask(ask("a")), { answer: "Fine.", costUsd: 0.0031, ms: 640 });
    await assert.rejects(t.ask({ ...ask("a"), question: "bad" }), /"usage.cost" in the response must be a number, 0 or more/);
  } finally {
    await s.close();
  }
});

test("jsonlTarget passes the recorded cost through", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-cost-"));
  await writeFile(join(dir, "answers.jsonl"), JSON.stringify({ id: "a", answer: "Fine.", costUsd: 0.004, ms: 300 }));
  const report = await runEval({ target: jsonlTarget(join(dir, "answers.jsonl")), cases: [{ ...ask("a"), maxCostUsd: 0.003 }] });
  assert.equal(report.cases[0]?.costUsd, 0.004);
  assert.deepEqual(
    report.cases[0]?.failures.map((f) => f.code),
    ["over-cost"],
  );
});

test("baseline: cost per answer is compared, a rise above costWarnPercent is a warning, not a failure", async () => {
  const run = (costUsd: number, ids = ["a", "b"]) =>
    runEval({ target: fixed({ costUsd, ms: 100 }), cases: ids.map(ask), now: () => new Date("2026-10-10T12:00:00Z") });
  const baseline = toBaseline(await run(0.002));
  assert.deepEqual(baseline.costUsd, { totalUsd: 0.004, meanUsd: 0.002, p90Usd: 0.002 });
  assert.equal(baseline.latencyMs.p95, 100);

  const dearer = compareReports(baseline, await run(0.003));
  assert.equal(dearer.passed, true, "a warning never fails the run");
  assert.deepEqual(dearer.changes, { totalCostPct: 50, meanCostPct: 50, p90CostPct: 50, p95LatencyPct: 0 });
  assert.deepEqual(dearer.warnings, [
    "cost per answer rose above the 20% warning: mean $0.00200 → $0.00300 (+50%), p90 $0.00200 → $0.00300 (+50%)",
  ]);
  assert.equal(compareReports(baseline, await run(0.003), { costWarnPercent: 60 }).warnings.length, 0);

  // Two more cases at the same price: the total rises 100%, nothing got more expensive, no warning.
  const bigger = compareReports(baseline, await run(0.002, ["a", "b", "c", "d"]));
  assert.equal(bigger.changes.totalCostPct, 100);
  assert.equal(bigger.changes.meanCostPct, 0);
  assert.deepEqual(bigger.warnings, []);
  const md = toMarkdown({ ...(await run(0.003)), baseline: dearer });
  assert.match(md, /Against the baseline: cost per answer: mean \+50%, p90 \+50% \(total \+50%\) · latency p95 0%\./);
  assert.match(md, /Note: cost per answer rose above the 20% warning/);

  const older = { ...baseline };
  delete older.costUsd;
  const noCost = compareReports(older, await run(0.003));
  assert.deepEqual(
    noCost.changes,
    { totalCostPct: null, meanCostPct: null, p90CostPct: null, p95LatencyPct: 0 },
    "an older baseline stays valid",
  );
});

test("from the command line: cost, unchecked limits and an invalid costWarnPercent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-cost-cli-"));
  await writeFile(
    join(dir, "answers.jsonl"),
    [JSON.stringify({ id: "a", answer: "Fine.", costUsd: 0.002, ms: 300 }), JSON.stringify({ id: "b", answer: "Fine." })].join("\n"),
  );
  const config = (extra: string) =>
    writeFile(
      join(dir, "noxeval.config.mjs"),
      `import { defineConfig, jsonlTarget } from ${JSON.stringify(INDEX)};
export default defineConfig({ target: jsonlTarget(new URL("./answers.jsonl", import.meta.url)),
  cases: [{ id: "a", question: "q" }, { id: "b", question: "q" }], checks: { maxCostUsd: 0.01, maxLatencyMs: 1000 }${extra} });
`,
    );
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
      delete env.FORCE_COLOR;
      delete env.GITHUB_STEP_SUMMARY;
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
    });
  await config("");
  const ok = await cli(["run"]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /latency p50 300 ms · p90 300 ms · p95 300 ms/);
  assert.match(ok.out, /cost: total \$0\.00200 · mean \$0\.00200 · p90 \$0\.00200 per answer \(1 answer without a cost\)/);
  assert.match(ok.out, /limits not checked: cost on 1 case\(s\), no costUsd reported: b; latency on 1 case\(s\), not timed: b/);
  await config(", costWarnPercent: -1");
  const bad = await cli(["run"]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /costWarnPercent must be a number, 0 or more/);
});
