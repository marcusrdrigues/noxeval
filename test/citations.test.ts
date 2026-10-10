import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkCitations, citedIds, citationsApply, type Source } from "../src/domain/citations.ts";
import { failureKind } from "../src/domain/checks.ts";
import { parseCaseFile, type EvalCase } from "../src/domain/case.ts";
import { functionTarget, httpTarget } from "../src/adapters/http-target.ts";
import { runEval } from "../src/app/run.ts";
import { fakeServer, json } from "./helpers.ts";

const base: EvalCase = { id: "cdc", question: "Can a store refuse to exchange a faulty product?", locale: "en" };
const sources = (...ids: string[]): Source[] => ids.map((id) => ({ id, text: `passage ${id}` }));
const codes = (answer: string, s: Source[] | undefined, c: EvalCase = base) => checkCitations(answer, s, c).map((f) => f.code);

test("citedIds: brackets with ids, distinct and in order; Markdown links and images are not citations", () => {
  assert.deepEqual(citedIds("The CDC protects you [cdc-art-6][3], again [cdc-art-6]."), ["cdc-art-6", "3"]);
  assert.deepEqual(citedIds("See [the code](https://example.com) and ![chart](x.png)."), []);
  assert.deepEqual(citedIds("[sumula-stj:297] and [lei/8078.art-18]"), ["sumula-stj:297", "lei/8078.art-18"]);
  assert.deepEqual(citedIds("Two at once [1, 2] is not the default shape."), []);
  assert.deepEqual(citedIds("(source: cdc-6) (source: cdc-18)", { pattern: String.raw`\(source: ([\w-]+)\)` }), ["cdc-6", "cdc-18"]);
  assert.deepEqual(citedIds("{a} {b}", { pattern: String.raw`\{\w\}` }), ["{a}", "{b}"], "no group: the whole match is the id");
});

test("acceptance 1: citing [x] when the sources were [a, b] is citation-unknown, a safety failure", () => {
  const f = checkCitations("Yes [a], and also [x].", sources("a", "b"), base);
  assert.deepEqual(f, [{ code: "citation-unknown", detail: "[x] is not among the sources" }]);
  assert.equal(failureKind("citation-unknown"), "safety");
  assert.deepEqual(codes("Yes [a][b].", sources("a", "b")), []);
  assert.deepEqual(codes("Yes [A].", sources("a")), ["citation-unknown"], "ids compare exactly");
});

test("acceptance 1: with repeat and minPassRate < 1, one invented source in any attempt fails the case", async () => {
  const answers = ["Yes [a].", "Yes [x].", "Yes [a].", "Yes [a]."];
  let i = 0;
  const target = functionTarget("fake", () => Promise.resolve({ answer: answers[i++ % answers.length] ?? "", sources: sources("a", "b") }));
  const report = await runEval({ target, cases: [base], repeat: 4, minPassRate: 0.5 });
  const c = report.cases[0];
  assert.equal(c?.passRate, 0.75);
  assert.equal(c?.passed, false);
  assert.deepEqual(
    c?.failures.map((f) => f.code),
    ["citation-unknown"],
  );
});

test("acceptance 2: mustCite groups need one id each", () => {
  const c = { ...base, mustCite: [["a"], ["b", "c"]] };
  const s = sources("a", "b", "c");
  assert.deepEqual(codes("Yes [a], see [c].", s, c), []);
  assert.deepEqual(checkCitations("Yes [a].", s, c), [{ code: "citation-missing", detail: "b | c" }]);
  assert.equal(failureKind("citation-missing"), "usefulness");
});

test("acceptance 3: mustCite with no reported sources fails with no-sources", () => {
  const c = { ...base, mustCite: [["a"]] };
  assert.deepEqual(codes("Yes [a].", undefined, c), ["no-sources"]);
  assert.deepEqual(codes("Yes [a].", [], c), ["citation-unknown"], "[] means 'received nothing', which is checkable");
  assert.deepEqual(codes("Yes.", [], c), ["citation-missing"]);
});

test("mustNotCite: forbidden ids are a safety failure, with or without sources, reported once", () => {
  const c = { ...base, mustNotCite: ["poison"] };
  assert.deepEqual(codes("Yes [poison].", sources("a", "poison"), c), ["citation-forbidden"]);
  assert.deepEqual(codes("Yes [poison].", undefined, c), ["citation-forbidden"]);
  assert.deepEqual(codes("Yes [poison].", sources("a"), c), ["citation-forbidden"], "not also citation-unknown");
  assert.equal(failureKind("citation-forbidden"), "safety");
});

test("the check applies only with sources or citation fields, and never with citations: false", () => {
  assert.equal(citationsApply(base, undefined), false);
  assert.deepEqual(codes("Made up [zz].", undefined), [], "no sources and no expectations: behaves like 0.5");
  assert.equal(citationsApply(base, sources("a")), true);
  assert.equal(citationsApply({ ...base, citations: false }, sources("a")), false);
  assert.deepEqual(codes("I only answer consumer law questions [zz].", sources("a"), { ...base, citations: false }), []);
});

test("case file: citation fields are validated", () => {
  const ok = parseCaseFile([{ ...base, mustCite: [["a"], ["b", "c"]], mustNotCite: ["p"] }]).cases[0];
  assert.deepEqual(ok?.mustCite, [["a"], ["b", "c"]]);
  assert.throws(() => parseCaseFile([{ ...base, mustCite: ["a"] }]), /"mustCite" must be an array of non-empty id arrays/);
  assert.throws(() => parseCaseFile([{ ...base, mustCite: [[]] }]), /"mustCite" must be/);
  assert.throws(() => parseCaseFile([{ ...base, mustNotCite: [] }]), /"mustNotCite" must be a non-empty array/);
  assert.throws(() => parseCaseFile([{ ...base, citations: true }]), /"citations" can only be false/);
  assert.throws(() => parseCaseFile([{ ...base, citations: false, mustCite: [["a"]] }]), /contradicts/);
});

test("run: sources become the context when there is none, citations land in the report", async () => {
  const seen: string[][] = [];
  const judge = {
    name: "fake",
    judge: (input: { context: string[] }) => {
      seen.push(input.context);
      return Promise.resolve({ pass: true, confidence: 1, signals: {} });
    },
  };
  const withContext = { ...base, id: "explicit" };
  const target = functionTarget("fake", (c) =>
    Promise.resolve({
      answer: "Yes [a].",
      sources: sources("a", "b"),
      ...(c.id === "explicit" ? { context: ["given"] } : {}),
    }),
  );
  const report = await runEval({ target, cases: [base, withContext], judge });
  assert.deepEqual(seen, [["passage a", "passage b"], ["given"]], "an explicit context wins");
  assert.deepEqual(report.cases[0]?.citations, { sources: ["a", "b"], cited: ["a"] });
  assert.equal(report.cases[0]?.contextSize, 2);
  assert.equal(report.cases[0]?.passed, true);

  const plain = await runEval({ target: functionTarget("plain", () => Promise.resolve("Yes [a].")), cases: [base] });
  assert.equal(plain.cases[0]?.citations, undefined, "nothing to check, nothing recorded");
});

test("run: a broken citation pattern fails before any call", async () => {
  let calls = 0;
  const target = functionTarget("fake", () => (calls++, Promise.resolve("ok")));
  await assert.rejects(runEval({ target, cases: [base], checks: { citations: { pattern: "[" } } }), /checks.citations.pattern/);
  assert.equal(calls, 0);
});

test("http target: sourcesPath reads { id, text } with string or number ids, and rejects malformed sources", async () => {
  const s = await fakeServer((body, _req, res) => {
    if (body.question === "bad") return json(res, { answer: "x", sources: [{ id: "a", text: "A" }, { text: "no id" }] });
    if (body.question === "not-array") return json(res, { answer: "x", sources: { id: "a" } });
    if (body.question === "none") return json(res, { answer: "x" });
    json(res, {
      answer: "Yes [cdc-art-6].",
      sources: [
        { id: "cdc-art-6", text: "Art. 6" },
        { id: 3, text: "third" },
      ],
    });
  });
  try {
    const t = httpTarget({ url: s.url, answerPath: "answer", sourcesPath: "sources" });
    assert.deepEqual(await t.ask(base), {
      answer: "Yes [cdc-art-6].",
      sources: [
        { id: "cdc-art-6", text: "Art. 6" },
        { id: "3", text: "third" },
      ],
    });
    await assert.rejects(t.ask({ ...base, question: "bad" }), /source #2 at "sources" needs an "id"/);
    await assert.rejects(t.ask({ ...base, question: "not-array" }), /no array at "sources"/);
    assert.deepEqual(await t.ask({ ...base, question: "none" }), { answer: "x" }, "missing sources: can't verify, not an error");
  } finally {
    await s.close();
  }
});

test("acceptance 9: no runtime dependency", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;
  assert.equal(pkg.dependencies, undefined);
});
