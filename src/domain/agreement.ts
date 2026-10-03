/**
 * Agreement between a human (the ground truth) and a rater (the judge or the checker), with Cohen's kappa:
 * (observed agreement - agreement expected by chance) / (1 - agreement expected by chance).
 *
 * Why kappa and not plain agreement: when almost every answer is correct, a rater that passes everything gets a
 * high agreement and a kappa of zero. When both always give the same verdict, chance agreement is 1 and kappa is
 * undefined (null).
 */

export type Pair = { human: boolean; rater: boolean };

export type AgreementStats = {
  n: number;
  agree: number;
  agreement: number | null;
  kappa: number | null;
  matrix: { bothPass: number; bothFail: number; raterPassHumanFail: number; raterFailHumanPass: number };
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function agreementStats(pairs: Pair[]): AgreementStats {
  const matrix = { bothPass: 0, bothFail: 0, raterPassHumanFail: 0, raterFailHumanPass: 0 };
  for (const { human, rater } of pairs) {
    if (human && rater) matrix.bothPass++;
    else if (!human && !rater) matrix.bothFail++;
    else if (rater) matrix.raterPassHumanFail++;
    else matrix.raterFailHumanPass++;
  }
  const n = pairs.length;
  if (n === 0) return { n, agree: 0, agreement: null, kappa: null, matrix };
  const agree = matrix.bothPass + matrix.bothFail;
  const observed = agree / n;
  const humanPass = (matrix.bothPass + matrix.raterFailHumanPass) / n;
  const raterPass = (matrix.bothPass + matrix.raterPassHumanFail) / n;
  const chance = humanPass * raterPass + (1 - humanPass) * (1 - raterPass);
  return { n, agree, agreement: round3(observed), kappa: chance >= 1 ? null : round3((observed - chance) / (1 - chance)), matrix };
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? null;
}
