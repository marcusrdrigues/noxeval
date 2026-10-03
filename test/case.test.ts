import { test } from "node:test";
import assert from "node:assert/strict";
import { CaseFileError, parseCaseFile, parsePlantedFile } from "../src/domain/case.ts";

test("a valid case file parses, with refusal patterns", () => {
  const f = parseCaseFile({
    refusalPatterns: { en: ["I only answer"] },
    cases: [{ id: "a", question: "Q?", locale: "en", refusal: true }],
  });
  assert.equal(f.cases.length, 1);
  assert.deepEqual(f.refusalPatterns, { en: ["I only answer"] });
  assert.equal(parseCaseFile([{ id: "b", question: "Q?" }]).cases[0]?.id, "b");
});

test("every problem is reported at once", () => {
  const bad = {
    cases: [
      { id: "a", question: "" },
      { id: "a", question: "Q", mustInclude: ["not", "nested"], mustNotMatch: ["("] },
      { id: "r", question: "Q", locale: "pt", refusal: true },
      "nope",
    ],
  };
  assert.throws(
    () => parseCaseFile(bad, "cases.json"),
    (err: unknown) => {
      assert.ok(err instanceof CaseFileError);
      assert.equal(err.problems.length, 6);
      assert.match(err.message, /cases\.json: 6 problem/);
      return true;
    },
  );
  assert.throws(() => parseCaseFile({}), CaseFileError);
  assert.throws(() => parseCaseFile([]), /no cases/);
});

test("planted errors must point to existing cases", () => {
  const ids = new Set(["a"]);
  assert.equal(parsePlantedFile({ items: [{ id: "p", caseId: "a", answer: "x", difficulty: "subtle" }] }, ids).length, 1);
  assert.throws(
    () => parsePlantedFile([{ id: "p", caseId: "zzz", answer: "x", difficulty: "hard" }], ids),
    (err: unknown) => {
      assert.ok(err instanceof CaseFileError);
      assert.equal(err.problems.length, 2);
      return true;
    },
  );
});
