import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { jsonlTarget, parseJsonl } from "../src/adapters/jsonl-target.ts";
import { parseCaseFile, type EvalCase } from "../src/domain/case.ts";
import { failureKind } from "../src/domain/checks.ts";
import { runEval } from "../src/app/run.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src/cli/main.ts");
const INDEX = pathToFileURL(join(ROOT, "src/index.ts")).href;

const hours: EvalCase = { id: "hours", question: "When do you open?", locale: "en", mustInclude: [["9"]] };
const close: EvalCase = { id: "close", question: "When do you close?", locale: "en", mustInclude: [["6"]] };

async function file(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-jsonl-"));
  const path = join(dir, "answers.jsonl");
  await writeFile(path, content);
  return path;
}
const line = (o: Record<string, unknown>) => JSON.stringify(o);

test("parseJsonl: byte-order mark, Windows line endings, blank lines, number ids, several lines per id", () => {
  const text = `${String.fromCharCode(0xfeff)}${line({ id: "a", answer: "one" })}\r\n\r\n${line({ id: 7, answer: "seven" })}\r\n${line({ id: "a", answer: "two" })}\n`;
  const byId = parseJsonl(text, "answers.jsonl");
  assert.deepEqual(
    byId.get("a")?.map((r) => r.answer),
    ["one", "two"],
  );
  assert.equal(byId.get("7")?.[0]?.answer, "seven");
});

test("parseJsonl: every field read like httpTarget reads it; ms null when the line wasn't timed", () => {
  const byId = parseJsonl(
    line({
      id: "a",
      answer: "Yes [s1].",
      context: ["plain", { text: "object" }],
      sources: [{ id: 1, text: "Art. 1" }],
      toolCalls: [{ function: { name: "search", arguments: '{"q":"cdc"}' } }],
      meta: { model: "m-1", cached: true, n: null },
      costUsd: 0.002,
      ms: 840,
    }) +
      "\n" +
      line({ id: "b", answer: "untimed" }),
    "answers.jsonl",
  );
  assert.deepEqual(byId.get("a")?.[0], {
    answer: "Yes [s1].",
    context: ["plain", "object"],
    sources: [{ id: "1", text: "Art. 1" }],
    toolCalls: [{ name: "search", args: { q: "cdc" } }],
    meta: { model: "m-1", cached: true, n: null },
    ms: 840,
    costUsd: 0.002,
  });
  assert.deepEqual(byId.get("b")?.[0], { answer: "untimed", ms: null });
  assert.equal(parseJsonl(line({ key: "x", answer: "y" }), "f", "key").get("x")?.[0]?.answer, "y", "idField");
});

test("parseJsonl: every problem at once, with line numbers", () => {
  const text = [
    "not json",
    "[1, 2]",
    line({ answer: "no id" }),
    line({ id: "a" }),
    line({ id: "b", answer: "x", sources: [{ id: "s" }], ms: -1, costUsd: "free", meta: { deep: {} } }),
    line({ id: "c", answer: "x", context: "a string", toolCalls: [{ args: {} }] }),
  ].join("\n");
  assert.throws(
    () => parseJsonl(text, "answers.jsonl"),
    (err: Error) => {
      assert.match(err.message, /^answers.jsonl: 10 problem\(s\)/);
      for (const p of [
        /line 1: not valid JSON/,
        /line 2: must be a JSON object/,
        /line 3: "id" is required/,
        /line 4 \(a\): "answer" must be a string/,
        /line 5 \(b\): source #1 needs an "id"/,
        /line 5 \(b\): "meta" must be/,
        /line 5 \(b\): "ms" must be a number, 0 or more/,
        /line 5 \(b\): "costUsd" must be a number/,
        /line 6 \(c\): "context" must be an array/,
        /line 6 \(c\): "toolCalls" must be an array of calls with a "name"/,
      ])
        assert.match(err.message, p);
      return true;
    },
  );
  assert.throws(() => parseJsonl("\n\n", "empty.jsonl"), /empty.jsonl: no answers/);
  const many = Array.from({ length: 25 }, () => "x").join("\n");
  assert.throws(() => parseJsonl(many, "f"), /25 problem\(s\)[\s\S]*- and 5 more$/);
});

test("acceptance 7: a file of recorded answers is graded with no network call; a missing id fails with no-answer", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => Promise.reject(new Error("no network in this test")));
  const path = await file([line({ id: "hours", answer: "We open at 9.", ms: 120 }), line({ id: "elsewhere", answer: "x" })].join("\n"));
  const report = await runEval({ target: jsonlTarget(path), cases: [hours, close] });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(report.target, "answers.jsonl");
  assert.equal(report.cases[0]?.passed, true);
  assert.equal(report.cases[0]?.ms, 120, "the recorded time, not the time to read the file");
  assert.deepEqual(report.cases[1]?.failures, [{ code: "no-answer", detail: 'no line for "close" in answers.jsonl' }]);
  assert.equal(failureKind("no-answer"), "usefulness");
  assert.deepEqual(report.notes, ["1 id(s) in answers.jsonl match no case: elsewhere"]);
});

test("untimed lines leave latency unmeasured instead of reporting 0 ms", async () => {
  const report = await runEval({ target: jsonlTarget(await file(line({ id: "hours", answer: "At 9." }))), cases: [hours] });
  assert.equal(report.cases[0]?.ms, null);
  assert.deepEqual(report.latencyMs, { p50: null, p90: null, p95: null });
});

test("repeat: lines are used in order, one per attempt; an attempt past the last line is no-answer, never a reused line", async () => {
  const path = await file([line({ id: "hours", answer: "At 9." }), line({ id: "hours", answer: "At noon." })].join("\n"));
  const report = await runEval({ target: jsonlTarget(path), cases: [hours], repeat: 3, minPassRate: 0.3 });
  const attempts = report.cases[0]?.attempts ?? [];
  assert.deepEqual(
    attempts.map((a) => a.answer),
    ["At 9.", "At noon.", ""],
  );
  assert.deepEqual(attempts[2]?.failures, [{ code: "no-answer", detail: 'answers.jsonl has 2 line(s) for "hours"; attempt 3 has none' }]);
  // A second run on the same target starts from the first line again.
  const again = await runEval({ target: jsonlTarget(path), cases: [hours] });
  assert.equal(again.cases[0]?.answer, "At 9.");
});

test("a broken file stops the run before any case; --only doesn't make the other ids look like typos", async () => {
  let started = 0;
  const broken = jsonlTarget(await file("{oops"));
  await assert.rejects(
    runEval({ target: broken, cases: [hours], onStart: () => started++ }),
    /answers.jsonl: 1 problem\(s\)\n- line 1: not valid JSON/,
  );
  assert.equal(started, 0);
  const path = await file([line({ id: "hours", answer: "9" }), line({ id: "close", answer: "6" })].join("\n"));
  const only = await runEval({ target: jsonlTarget(path), cases: [hours], suite: [hours, close] });
  assert.equal(only.notes, undefined);
  await assert.rejects(
    runEval({ target: jsonlTarget(join(tmpdir(), "missing-answers.jsonl")), cases: [hours] }),
    /missing-answers.jsonl: ENOENT/,
  );
});

test("a URL path is relative to the config file", async () => {
  const path = await file(line({ id: "hours", answer: "At 9." }));
  const report = await runEval({ target: jsonlTarget(pathToFileURL(path), { name: "recorded" }), cases: [hours] });
  assert.equal(report.target, "recorded");
  assert.equal(report.cases[0]?.passed, true);
});

test("the example grades as documented: one invented source, everything else passes", async () => {
  const dir = join(ROOT, "examples/recorded");
  const { cases, refusalPatterns } = parseCaseFile(JSON.parse(await readFile(join(dir, "noxeval.cases.json"), "utf8")));
  const report = await runEval({ target: jsonlTarget(join(dir, "answers.jsonl")), cases, checks: { refusalPatterns } });
  assert.deepEqual(
    report.cases.map((c) => [c.id, c.failures.map((f) => f.code)]),
    [
      ["faulty-product", []],
      ["advertised-price", ["citation-unknown"]],
      ["off-topic", []],
    ],
  );
});

test("from the command line: notes in the terminal, a broken file is a usage error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-jsonl-cli-"));
  await writeFile(join(dir, "answers.jsonl"), [line({ id: "hours", answer: "At 9." }), line({ id: "hourz", answer: "typo" })].join("\n"));
  await writeFile(
    join(dir, "noxeval.config.mjs"),
    `import { defineConfig, jsonlTarget } from ${JSON.stringify(INDEX)};
export default defineConfig({ target: jsonlTarget(new URL("./answers.jsonl", import.meta.url)), cases: [{ id: "hours", question: "q", mustInclude: [["9"]] }] });
`,
  );
  const run = (args: string[]) =>
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
  const ok = await run(["run"]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /note: 1 id\(s\) in answers.jsonl match no case: hourz/);
  await writeFile(join(dir, "answers.jsonl"), "{oops");
  const broken = await run(["run"]);
  assert.equal(broken.code, 2);
  assert.match(broken.out, /line 1: not valid JSON/);
});
