import { test } from "node:test";
import assert from "node:assert/strict";
import { agreementStats, percentile } from "../src/domain/agreement.ts";

const pairs = (spec: [boolean, boolean][]) => spec.map(([human, rater]) => ({ human, rater }));
const repeat = (n: number, v: [boolean, boolean]): [boolean, boolean][] => Array.from({ length: n }, () => v);

test("Cohen's kappa matches the hand calculation", () => {
  // observed 0.8; both pass 70% of the time; chance 0.49 + 0.09 = 0.58; kappa 0.22 / 0.42 = 0.524
  const s = agreementStats(pairs([...repeat(6, [true, true]), ...repeat(2, [false, false]), [false, true], [true, false]]));
  assert.equal(s.agreement, 0.8);
  assert.equal(s.kappa, 0.524);
  assert.deepEqual(s.matrix, { bothPass: 6, bothFail: 2, raterPassHumanFail: 1, raterFailHumanPass: 1 });
});

test("a rater that passes everything: high agreement, zero kappa", () => {
  const s = agreementStats(pairs([...repeat(9, [true, true]), [false, true]]));
  assert.equal(s.agreement, 0.9);
  assert.equal(s.kappa, 0);
});

test("kappa is undefined when both always agree on one verdict", () => {
  assert.equal(agreementStats(pairs(repeat(5, [true, true]))).kappa, null);
  assert.deepEqual(agreementStats([]), {
    n: 0,
    agree: 0,
    agreement: null,
    kappa: null,
    matrix: { bothPass: 0, bothFail: 0, raterPassHumanFail: 0, raterFailHumanPass: 0 },
  });
});

test("nearest-rank percentile", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.9), 5);
  assert.equal(percentile([], 0.5), null);
});
