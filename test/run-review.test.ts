import { test } from "node:test";
import assert from "node:assert/strict";
import { runEval } from "../src/app/run.ts";
import { toMarkdown } from "../src/app/markdown.ts";
import { functionTarget } from "../src/adapters/http-target.ts";
import { buildReview, grade, summarizeReview } from "../src/domain/review.ts";
import type { EvalCase } from "../src/domain/case.ts";
import type { Judge } from "../src/ports.ts";

const cases: EvalCase[] = [
  { id: "hours", question: "When are you open?", locale: "en", category: "fact", mustInclude: [["9"]], tags: ["LLM09"] },
  { id: "france", question: "Capital of France?", locale: "en", category: "off-topic", refusal: true },
  { id: "rome", question: "Capital of Italy?", locale: "en", category: "off-topic", refusal: true },
  { id: "boom", question: "Crash please", locale: "en", category: "fact" },
];
const answers: Record<string, string> = {
  hours: "We open at 9am.",
  france: "I only answer questions about the store.",
  rome: "I only answer questions about the store.",
};
const target = functionTarget("fake", async (c) => {
  if (c.id === "boom") throw new Error("target down");
  return { answer: answers[c.id] ?? "", context: c.id === "hours" ? ["Open 9am to 6pm."] : [] };
});
// A stub judge: fails any answer with "24 hours" in it, and is unsure about refusals.
const judge: Judge = {
  name: "stub",
  async judge({ answer, case: c }) {
    if (answer.includes("Sunday")) throw new Error("judge down");
    return { pass: !answer.includes("24 hours"), confidence: c.refusal ? 0.4 : 0.9, signals: {}, model: "stub-1" };
  },
};
const planted = [
  { id: "p-obvious", caseId: "hours", answer: "Open 24 hours.", difficulty: "obvious" as const },
  { id: "p-subtle", caseId: "hours", answer: "Open 9am to 6pm, Monday to Sunday.", difficulty: "subtle" as const },
];

test("a run checks, judges, grades planted errors and survives a failing target", async () => {
  const report = await runEval({
    target,
    cases,
    judge,
    planted,
    checks: { refusalPatterns: { en: ["I only answer"] } },
    concurrency: 2,
    now: () => new Date("2026-10-03T12:00:00Z"),
  });
  assert.equal(report.total, 4);
  assert.equal(report.passed, 3);
  assert.deepEqual(report.cases.find((c) => c.id === "boom")?.failures, [{ code: "error", detail: "target down" }]);
  assert.deepEqual(report.categories, { fact: { passed: 1, total: 2 }, "off-topic": { passed: 2, total: 2 } });
  assert.deepEqual(report.tags, { LLM09: { passed: 1, total: 1 } });
  assert.equal(report.judge?.model, "stub-1");
  assert.equal(report.judge?.agreementWithChecker, 1);
  assert.deepEqual(report.judge?.lowConfidence, ["france", "rome"]);
  assert.equal(report.planted?.caught, 1);
  assert.deepEqual(report.planted?.byDifficulty, { obvious: { total: 1, caught: 1 }, subtle: { total: 1, caught: 0 } });
  assert.equal(report.planted?.results[1]?.error, "judge down");

  const md = toMarkdown(report);
  assert.match(md, /## noxeval: 3\/4 passed ❌/);
  assert.match(md, /`boom` \| error: target down/);
  assert.match(md, /Planted errors: judge caught 1\/2/);

  // Blind review: the duplicate refusal appears once, the planted error the judge could not grade is left out,
  // and the file never holds a verdict before the grade.
  const { review, hidden } = buildReview(report, "2026-10-03T13:00:00Z");
  assert.deepEqual(review.items.map((i) => i.key).sort(), ["france", "hours", "p-obvious"]);
  assert.ok(review.items.every((i) => i.judge === undefined && i.checker === undefined));
  assert.deepEqual(
    buildReview(report, "x").review.items.map((i) => i.key),
    review.items.map((i) => i.key),
  );
  grade(review, "hours", true, "", hidden, "t1");
  grade(review, "p-obvious", false, "made up", hidden, "t2");
  const s = summarizeReview(review);
  assert.equal(s?.reviewed, 2);
  assert.equal(s?.judgeAgreement.agree, 2);
  assert.deepEqual(s?.planted, { total: 1, judgeCaught: 1, humanCaught: 1 });
  assert.equal(review.items.find((i) => i.key === "p-obvious")?.note, "made up");
  assert.throws(() => grade(review, "nope", true, "", hidden, "t3"));
});

test("without a judge, planted errors are skipped", async () => {
  const report = await runEval({ target, cases: cases.slice(0, 1), planted });
  assert.equal(report.judge, null);
  assert.equal(report.planted, null);
});
