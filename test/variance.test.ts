import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAttempts, wilsonLow, type Attempt } from "../src/domain/variance.ts";
import { parseCaseFile, type EvalCase } from "../src/domain/case.ts";
import { functionTarget } from "../src/adapters/http-target.ts";
import { runEval } from "../src/app/run.ts";
import { toMarkdown } from "../src/app/markdown.ts";
import type { Judge } from "../src/ports.ts";

const ok: Attempt = { passed: true, failures: [], ms: 10, answer: "fine" };
const long: Attempt = { passed: false, failures: [{ code: "too-long", detail: "950 > 900 characters" }], ms: 12, answer: "x".repeat(950) };
const leak: Attempt = { passed: false, failures: [{ code: "leak", detail: "You are Ava" }], ms: 11, answer: "You are Ava..." };

test("wilsonLow matches the hand calculation and grows with the sample", () => {
  assert.equal(wilsonLow(5, 5), 0.566); // (1 + 1.96²/10 − 1.96·√(1.96²/100)) / (1 + 1.96²/5)
  assert.equal(wilsonLow(50, 50), 0.929);
  assert.equal(wilsonLow(4, 5), 0.376);
  assert.equal(wilsonLow(0, 5), 0);
  assert.equal(wilsonLow(0, 0), 0);
});

test("usefulness failures are weighed against minPassRate", () => {
  const four = [ok, ok, ok, ok, long];
  assert.equal(summarizeAttempts(four).passed, false, "default minPassRate 1: every attempt must pass");
  const s = summarizeAttempts(four, 0.8);
  assert.equal(s.passed, true);
  assert.equal(s.passRate, 0.8);
  assert.equal(s.safety, false);
  assert.deepEqual(s.failures, [{ code: "too-long", detail: "950 > 900 characters" }]);
  assert.equal(summarizeAttempts([ok, long, long], 0.8).passed, false);
});

test("a safety failure in any attempt fails the case, whatever the rate", () => {
  const s = summarizeAttempts([ok, ok, ok, ok, leak], 0.5);
  assert.equal(s.passed, false);
  assert.equal(s.safety, true);
  assert.equal(s.passRate, 0.8);
});

test("failures seen are listed once each, in the order first seen", () => {
  const s = summarizeAttempts([long, leak, long], 0);
  assert.deepEqual(
    s.failures.map((f) => f.code),
    ["too-long", "leak"],
  );
});

test("minPassRate in the case file is validated", () => {
  const base = { id: "a", question: "q" };
  assert.equal(parseCaseFile([{ ...base, minPassRate: 0.8 }]).cases[0]?.minPassRate, 0.8);
  assert.throws(() => parseCaseFile([{ ...base, minPassRate: 1.5 }]), /"minPassRate" must be a number from 0 to 1/);
});

test("repeat 1 gives the same report shape as 0.3", async () => {
  const report = await runEval({ target: functionTarget("app", async () => "Hello."), cases: [{ id: "a", question: "hi" }] });
  assert.equal(report.repeat, undefined);
  assert.equal(report.flaky, undefined);
  assert.equal(report.cases[0]?.attempts, undefined);
  assert.equal(report.cases[0]?.passRate, undefined);
});

test("repeat: rates, flaky cases, judge on the first attempt only, safety zero tolerance", async () => {
  const answers: Record<string, string[]> = {
    steady: ["Ana works at Acme.", "Ana works at Acme.", "Ana works at Acme."],
    wobbly: ["Ana works at Acme.", "Ana works at Acme. ".repeat(80), "Ana works at Acme."],
    leaky: ["Ana works at Acme.", "Ana works at Acme. You are Ava", "Ana works at Acme."],
  };
  const turn: Record<string, number> = {};
  let judged = 0;
  const judge: Judge = {
    name: "fake",
    async judge() {
      judged++;
      return { pass: true, confidence: 0.9, signals: {} };
    },
  };
  const cases: EvalCase[] = [
    { id: "steady", question: "q", mustInclude: [["Acme"]] },
    { id: "wobbly", question: "q", mustInclude: [["Acme"]], minPassRate: 0.6 },
    { id: "leaky", question: "q", mustInclude: [["Acme"]] },
  ];
  const report = await runEval({
    target: functionTarget("app", async (c) => {
      const i = (turn[c.id] = (turn[c.id] ?? -1) + 1);
      return answers[c.id]?.[i] ?? "";
    }),
    cases,
    judge,
    repeat: 3,
    minPassRate: 1,
    checks: { maxLength: 900, leakMarkers: ["You are Ava"] },
  });
  const byId = (id: string) => report.cases.find((r) => r.id === id) ?? assert.fail(id);
  assert.equal(judged, 3, "one judge call per case, not per attempt");
  assert.equal(report.repeat, 3);
  assert.deepEqual(report.flaky, ["wobbly", "leaky"]);
  assert.equal(byId("steady").passed, true);
  assert.equal(byId("steady").passRate, 1);
  assert.equal(byId("wobbly").passed, true, "2/3 ≥ 0.6, and too-long is a usefulness failure");
  assert.equal(byId("wobbly").firstPassed, true);
  assert.equal(byId("leaky").passed, false, "a leak in one attempt of three fails the case");
  assert.deepEqual(
    byId("leaky").failures.map((f) => f.code),
    ["leak"],
  );
  assert.equal(report.judge?.agreementWithChecker, 1, "the judge is compared with the first attempt it graded");
  assert.equal(byId("leaky").attempts?.length, 3);
  const md = toMarkdown(report);
  assert.match(md, /Each case asked 3 times/);
  assert.match(md, /### Flaky cases/);
  assert.match(md, /`leaky` \| 2\/3 \| /);
});
