import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalNumber, extractDetails, numberSet, splitSentences, ungroundedDetails, type Detail } from "../src/domain/grounding.ts";
import { runEval } from "../src/app/run.ts";
import { toMarkdown } from "../src/app/markdown.ts";
import { functionTarget } from "../src/adapters/http-target.ts";
import { parseCaseFile, type EvalCase } from "../src/domain/case.ts";
import { failureKind } from "../src/domain/checks.ts";

// The rules come from Nox (marcusrdrigues.com), where this check ran before anything else. Each test is a case it met.

const brief = (details: Detail[]) => details.map((d) => `${d.kind}:${d.text}`);
const ALLOW = ["Marcus Rodrigues", "Nox", "LinkedIn", "GitHub"];

test("canonical numbers: thousands, decimals and multiplier words", () => {
  assert.equal(canonicalNumber("10 mil"), "10000");
  assert.equal(canonicalNumber("10.000"), "10000");
  assert.equal(canonicalNumber("10,000"), "10000");
  assert.equal(canonicalNumber("1.200"), "1200");
  assert.equal(canonicalNumber("0,61"), "0.61");
  assert.equal(canonicalNumber("0.78"), "0.78");
  assert.equal(canonicalNumber("2 milhões"), "2000000");
  assert.equal(canonicalNumber("3 million"), "3000000");
  assert.equal(canonicalNumber("49"), "49");
});

test("context numbers: words count, identifiers don't", () => {
  const set = numberSet("Cinco trechos, dez mil vistorias, ten thousand rows, BM25, text-embedding-3-small, de mar/2023 a 49%.");
  for (const n of ["5", "10", "10000", "2023", "49"]) assert.ok(set.has(n), n);
  assert.ok(!set.has("25"));
  assert.ok(!set.has("3"));
});

test("sentences split at . ? ! : and line breaks", () => {
  assert.deepEqual(splitSentences("First. Second? Third: fourth\nFifth"), ["First.", "Second?", "Third:", "fourth", "Fifth"]);
});

test("details: numbers, acronyms and proper names, not the first word of a sentence", () => {
  const d = extractDetails("Marcus trabalha na Vibetex desde 2026 com Java e Spring Boot, e cuidou da IA do projeto da CEDAE.", {
    allow: ALLOW,
  });
  assert.deepEqual(brief(d), ["number:2026", "name:Vibetex", "name:Java", "name:Spring Boot", "acronym:IA", "acronym:CEDAE"]);
  assert.deepEqual(brief(extractDetails("He spent three years at the OAB/RJ, in Rio de Janeiro.")), [
    "acronym:OAB/RJ",
    "name:Rio de Janeiro",
  ]);
  assert.deepEqual(brief(extractDetails("Uses .NET and Next.js; MRR went up to 0.78.")), [
    "number:0.78",
    "acronym:.NET",
    "name:Next.js",
    "acronym:MRR",
  ]);
});

test("the allow list is never a detail, and it splits neighboring names (the Nox baseline's false flag)", () => {
  assert.deepEqual(extractDetails("Talk to Marcus Rodrigues on LinkedIn or GitHub; Nox answers here.", { allow: ALLOW }), []);
  assert.deepEqual(brief(extractDetails("I didn't find how many years of Python Marcus has.", { allow: ALLOW })), ["name:Python"]);
  assert.deepEqual(
    brief(extractDetails("I didn't find how many years of Python Marcus has.")),
    ["name:Python Marcus"],
    "without the list, one name",
  );
});

const CONTEXT = [
  "Today I'm a full-stack developer at Vibetex (mar/2026), with Java, Spring Boot and AI.",
  "CEDAE project: more than 10 mil inspections, with an LLM and semantic search.",
];

test("a detail in the context passes; one that isn't is reported", () => {
  assert.deepEqual(ungroundedDetails("Marcus works at Vibetex since 2026, with Java and Spring Boot.", CONTEXT, { allow: ALLOW }), []);
  assert.deepEqual(ungroundedDetails("At CEDAE he handled over 10,000 inspections with LLMs.", CONTEXT, { allow: ALLOW }), []);
  assert.deepEqual(brief(ungroundedDetails("At CEDAE he handled 12,000 inspections in 2025 with Microsoft.", CONTEXT, { allow: ALLOW })), [
    "number:12,000",
    "number:2025",
    "name:Microsoft",
  ]);
});

test("the question's bait passes only in a sentence that negates it", () => {
  const question = "Did he win the Nobel prize in 2024?";
  assert.deepEqual(ungroundedDetails("I couldn't find a Nobel prize in 2024 on the site.", CONTEXT, { question }), []);
  assert.deepEqual(
    ungroundedDetails("Não encontrei um prêmio Nobel em 2024 no site.", CONTEXT, { question: "Ele ganhou o Nobel em 2024?" }),
    [],
  );
  assert.deepEqual(brief(ungroundedDetails("Yes, he won the Nobel prize in 2024.", CONTEXT, { question })), ["number:2024", "name:Nobel"]);
});

test("date arithmetic in plain sight is not invention; other numbers between two years are", () => {
  const ctx = ["Administrative officer at OAB/RJ, mar/2023 to mar/2026. Full-stack developer at Vibetex since mar/2026."];
  assert.deepEqual(ungroundedDetails("He joined OAB/RJ in 2023. He moved to Vibetex in 2026, 3 years later.", ctx), []);
  assert.deepEqual(ungroundedDetails("De 2023 a 2026, 3 anos.", ctx), []);
  assert.deepEqual(brief(ungroundedDetails("He moved to Vibetex 3 years later.", ctx)), ["number:3"], "without both years in the answer");
  assert.deepEqual(brief(ungroundedDetails("From 2023 to 2026 he built 3 projects.", ctx)), ["number:3"], "not a number of years");
  assert.deepEqual(brief(ungroundedDetails("From 2023 to 2026, 5 years.", ctx)), ["number:5"], "wrong arithmetic");
  assert.deepEqual(
    ungroundedDetails("He moved to Vibetex in 2026, 3 years later.", ctx, { contextYears: [2023] }),
    [],
    "years from other sentences",
  );
});

test("long input runs in linear time", () => {
  const long = "At CEDAE ".repeat(5000) + "1".repeat(5000);
  const t0 = performance.now();
  ungroundedDetails(long, CONTEXT, { question: long });
  assert.ok(performance.now() - t0 < 1000);
});

const cases: EvalCase[] = [
  { id: "work", question: "Where does he work?", locale: "en" },
  { id: "invented", question: "What did he do at CEDAE?", locale: "en" },
  { id: "no-context", question: "Hi?", locale: "en" },
  { id: "skipped", question: "Tell me a joke", locale: "en", grounding: false },
];
const answers: Record<string, string> = {
  work: "He works at Vibetex since 2026.",
  invented: "He led 12,000 inspections at CEDAE with Microsoft.",
  "no-context": "He works at Acme.",
  skipped: "Acme Corp 1999.",
};
const target = functionTarget("fake", async (c) => ({
  answer: answers[c.id] ?? "",
  ...(c.id === "no-context" ? {} : { context: CONTEXT }),
}));

test("grounding off: the report is the same as without the feature", async () => {
  const report = await runEval({ target, cases, now: () => new Date(0) });
  assert.equal(report.grounding, undefined);
  assert.ok(report.cases.every((r) => r.grounding === undefined));
  assert.equal(report.passed, 4);
});

test("report mode measures and never fails a case; no context is 'not checked', never grounded", async () => {
  const report = await runEval({ target, cases, checks: { grounding: "report", groundingAllow: ALLOW }, now: () => new Date(0) });
  assert.equal(report.passed, 4);
  assert.deepEqual(report.grounding, {
    mode: "report",
    checked: 2,
    notChecked: 1,
    withUngrounded: 1,
    cases: [{ id: "invented", details: ["12,000", "Microsoft"] }],
  });
  assert.deepEqual(report.cases.find((r) => r.id === "no-context")?.grounding, { checked: false, details: [] });
  assert.equal(report.cases.find((r) => r.id === "skipped")?.grounding, undefined, "grounding: false skips the case");
  const md = toMarkdown(report);
  assert.match(md, /### Ungrounded details: 1 of 2 answers \(report\)/);
  assert.match(md, /\| `invented` \| 12,000, Microsoft \|/);
  assert.match(md, /1 answers not checked/);
});

test("check mode fails the case with `ungrounded`, a usefulness failure weighed with minPassRate", async () => {
  const report = await runEval({ target, cases, checks: { grounding: "check" }, now: () => new Date(0) });
  const invented = report.cases.find((r) => r.id === "invented");
  assert.equal(invented?.passed, false);
  assert.deepEqual(invented?.failures, [{ code: "ungrounded", detail: "12,000, Microsoft" }]);
  assert.equal(failureKind("ungrounded"), "usefulness");
  assert.equal(report.cases.find((r) => r.id === "no-context")?.passed, true, "not checked is not a failure");

  let n = 0;
  const flaky = functionTarget("flaky", async () => ({
    answer: n++ % 2 ? "He works at Vibetex." : "He works at Microsoft.",
    context: CONTEXT,
  }));
  const repeated = await runEval({
    target: flaky,
    cases: [cases[0] as EvalCase],
    checks: { grounding: "check" },
    repeat: 4,
    minPassRate: 0.5,
  });
  assert.equal(repeated.cases[0]?.passRate, 0.5);
  assert.equal(repeated.cases[0]?.passed, true, "a usefulness failure respects minPassRate");
});

test("the case file accepts grounding: false and nothing else", () => {
  assert.equal(parseCaseFile({ cases: [{ id: "a", question: "q", grounding: false }] }).cases[0]?.grounding, false);
  assert.throws(() => parseCaseFile({ cases: [{ id: "a", question: "q", grounding: true }] }), /"grounding" can only be false/);
});
