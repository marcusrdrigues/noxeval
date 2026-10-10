import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compareReports, parseBaseline, toBaseline } from "../src/domain/baseline.ts";
import { buildReport, type CaseResult, type Report } from "../src/domain/report.ts";
import type { Failure } from "../src/domain/checks.ts";
import { toMarkdown } from "../src/app/markdown.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src/cli/main.ts");
const INDEX = pathToFileURL(join(ROOT, "src/index.ts")).href;

/** A case result: passes with no failures, fails with the given ones. */
const res = (id: string, ...failures: Failure[]): CaseResult => ({
  id,
  question: `question ${id}`,
  passed: failures.length === 0,
  failures,
  answer: `the answer of ${id}, never stored in a baseline`,
  contextSize: 0,
  ms: 10,
});
const report = (cases: CaseResult[], extra: Partial<Report> = {}): Report => ({
  ...buildReport({ version: "0.6.0", runAt: "2026-10-10T12:00:00.000Z", target: "app", judgeName: null, cases, planted: [] }),
  ...extra,
});
const missing: Failure = { code: "missing", detail: "9" };
const unknown = (id: string): Failure => ({ code: "citation-unknown", detail: `[${id}] is not among the sources` });

test("toBaseline: ids, verdicts and failure codes, sorted by id, without answers", () => {
  const b = toBaseline(report([res("b", missing, missing, unknown("x")), res("a")]));
  assert.equal(b.kind, "noxeval-baseline");
  assert.deepEqual(b.cases, [
    { id: "a", passed: true, failures: [] },
    { id: "b", passed: false, failures: ["citation-unknown", "missing"] },
  ]);
  assert.ok(!JSON.stringify(b).includes("never stored"), "answers stay out of the baseline");
  assert.throws(() => toBaseline(report([res("a")], { partial: true })), /partial run \(--only\)/);
});

test("parseBaseline: a baseline file, a full report, or a clear error", () => {
  const b = toBaseline(report([res("a")]));
  assert.deepEqual(parseBaseline(JSON.parse(JSON.stringify(b))), b);
  assert.deepEqual(parseBaseline(JSON.parse(JSON.stringify(report([res("a")])))), b, "a report is read as its baseline");
  assert.throws(() => parseBaseline({ cases: [] }, "x.json"), /x.json: not a noxeval baseline or report/);
  assert.throws(() => parseBaseline({ ...b, format: 2 }), /format 2 is not supported/);
  assert.throws(() => parseBaseline({ ...b, cases: [{ id: "a" }] }), /needs "id", "passed" and "failures"/);
});

test("acceptance 4: a case that failed and still fails is a known failure; the gate passes", () => {
  const baseline = toBaseline(report([res("a"), res("x", missing)]));
  const c = compareReports(baseline, report([res("a"), res("x", { code: "missing", detail: "another detail" })]));
  assert.equal(c.passed, true);
  assert.deepEqual(c.knownFailures, ["x"]);
  assert.deepEqual(c.regressed, []);
  assert.equal(c.unchanged, 1);
});

test("acceptance 5: a case that passed and fails now is a regression", () => {
  const baseline = toBaseline(report([res("a"), res("b")]));
  const c = compareReports(baseline, report([res("a"), res("b", missing)]));
  assert.equal(c.passed, false);
  assert.deepEqual(c.regressed, [{ id: "b", reason: "passed in the baseline, fails now: missing" }]);
  const md = toMarkdown({ ...report([res("a"), res("b", missing)]), baseline: c });
  assert.match(md, /## noxeval: 1 regressed ❌ \(1\/2 passed, 1 known failure\)/);
  assert.match(md, /\| Regressed \| `b` \|/);
  assert.match(md, /\| `b` \| passed in the baseline, fails now: missing \|/);
});

test("a new safety failure regresses a known failure; the same code with another detail does not", () => {
  const baseline = toBaseline(report([res("x", missing)]));
  const worse = compareReports(baseline, report([res("x", missing, unknown("z"))]));
  assert.deepEqual(worse.regressed, [{ id: "x", reason: "new safety failure: citation-unknown" }]);
  const sameCode = compareReports(toBaseline(report([res("x", unknown("y"))])), report([res("x", unknown("z"))]));
  assert.equal(sameCode.passed, true, "[y] becoming [z] is the same failure");
});

test("fixed, new and removed cases; a new case that fails is a regression", () => {
  const baseline = toBaseline(report([res("fixed", missing), res("gone")]));
  const c = compareReports(baseline, report([res("fixed"), res("added"), res("added-broken", missing)]));
  assert.deepEqual(c.fixed, ["fixed"]);
  assert.deepEqual(c.new, [
    { id: "added", passed: true },
    { id: "added-broken", passed: false },
  ]);
  assert.deepEqual(c.regressed, [{ id: "added-broken", reason: "new case, fails: missing" }]);
  assert.deepEqual(c.removed, ["gone"]);
  const md = toMarkdown({ ...report([res("fixed")]), baseline: c });
  assert.match(md, /Fixed cases are not guarded until accepted/);
});

test("a partial run lists nothing as removed; another target or repeat is a note, not a failure", () => {
  const baseline = toBaseline(report([res("a"), res("b"), res("c")]));
  const partial = compareReports(baseline, report([res("a")], { partial: true }));
  assert.deepEqual(partial.removed, []);
  assert.equal(partial.passed, true);
  const other = compareReports(baseline, report([res("a"), res("b"), res("c")], { target: "staging", repeat: 3 }));
  assert.equal(other.passed, true);
  assert.deepEqual(other.warnings, [
    "the baseline was taken against app, this run against staging",
    "the baseline asked each case 1 time(s), this run 3",
  ]);
});

test("flaky cases are listed; the verdict decides the gate", () => {
  const flaky = { ...res("w"), attempts: [], passRate: 0.8, passRateLow: 0.4 };
  const baseline = toBaseline(report([res("w")]));
  const c = compareReports(baseline, report([flaky], { repeat: 5, flaky: ["w"] }));
  assert.deepEqual(c.flaky, ["w"]);
  assert.equal(c.passed, true, "passed with minPassRate: not a regression");
});

// End to end through the CLI: the app's answers come from a file the test rewrites between runs.
function cli(args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    delete env.GITHUB_STEP_SUMMARY;
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("acceptance 4, 5 and 6 from the command line: known failures pass, regressions fail, only update writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-baseline-"));
  const answers = (a: string, b: string) => writeFile(join(dir, "answers.json"), JSON.stringify({ a, b }));
  await writeFile(
    join(dir, "noxeval.config.mjs"),
    `import { readFile } from "node:fs/promises";
import { defineConfig, functionTarget } from ${JSON.stringify(INDEX)};
export default defineConfig({
  target: functionTarget("recorded", async (c) => JSON.parse(await readFile(new URL("./answers.json", import.meta.url), "utf8"))[c.id]),
  cases: [
    { id: "a", question: "When do you open?", mustInclude: [["9"]] },
    { id: "b", question: "When do you close?", mustInclude: [["6"]] },
  ],
});
`,
  );
  const baselineFile = join(dir, "noxeval-baseline.json");

  await answers("At 9.", "Late.");
  const first = await cli(["run"], dir);
  assert.equal(first.code, 1, "no baseline: every case must pass");

  const missingRun = await cli(["run", "--baseline", "noxeval-baseline.json"], dir);
  assert.equal(missingRun.code, 1);
  assert.match(missingRun.out, /baseline noxeval-baseline.json not found: every case must pass/);

  const update = await cli(["baseline", "update"], dir);
  assert.equal(update.code, 0, update.out);
  assert.match(update.out, /first baseline: 2 cases, 1 passing; accepting 1 known failure\(s\): b/);
  const accepted = await readFile(baselineFile, "utf8");

  // Acceptance 4: b failed in the baseline and still fails, nothing else changed.
  const known = await cli(["run", "--baseline", "noxeval-baseline.json", "--markdown", "report.md"], dir);
  assert.equal(known.code, 0, known.out);
  assert.match(known.out, /baseline: 0 regressed · 0 fixed · 1 known failures/);
  assert.match(known.out, /known failures \(accepted, still failing\): b/);
  assert.match(await readFile(join(dir, "report.md"), "utf8"), /## noxeval: no regressions ✅ \(1\/2 passed, 1 known failure\)/);

  // Acceptance 5: a passed in the baseline and fails now.
  await answers("At 10.", "Late.");
  const regressed = await cli(["run", "--baseline", "noxeval-baseline.json", "--markdown", "report.md"], dir);
  assert.equal(regressed.code, 1);
  assert.match(regressed.out, /regressed a: passed in the baseline, fails now: missing/);
  assert.match(await readFile(join(dir, "report.md"), "utf8"), /\| Regressed \| `a` \|/);

  // Acceptance 6: runs never write the baseline; a partial run can't become one.
  assert.equal(await readFile(baselineFile, "utf8"), accepted);
  assert.equal((await cli(["run", "--only", "a"], dir)).code, 1);
  const partial = await cli(["baseline", "update"], dir);
  assert.equal(partial.code, 2);
  assert.match(partial.out, /partial run \(--only\)/);
  assert.equal(await readFile(baselineFile, "utf8"), accepted);

  // Accepting a fix guards it: the update says so, and the file changes only now.
  await answers("At 9.", "At 6.");
  assert.match((await cli(["run", "--baseline", "noxeval-baseline.json"], dir)).out, /1 fixed \(b\): accept them/);
  const fixed = await cli(["baseline", "update"], dir);
  assert.match(fixed.out, /now guarded \(fixed\): b/);
  assert.notEqual(await readFile(baselineFile, "utf8"), accepted);

  assert.equal((await cli(["baseline"], dir)).code, 2, "baseline without a subcommand is a usage error");
});
