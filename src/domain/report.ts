import type { Difficulty } from "./case.ts";
import type { Failure } from "./checks.ts";
import type { JudgeVerdict } from "../ports.ts";
import { percentile, type AgreementStats } from "./agreement.ts";

/** One case after a run. Carries what the blind review needs, so a report can be reviewed without the config. */
export type CaseResult = {
  id: string;
  question: string;
  expect?: string;
  locale?: string;
  category?: string;
  tags?: string[];
  passed: boolean;
  failures: Failure[];
  answer: string;
  /** Number of context items the target returned (RAG passages, for example). */
  contextSize: number;
  ms: number | null;
  meta?: Record<string, string | number | boolean | null>;
  judge?: JudgeVerdict | null;
  judgeError?: string;
};

export type PlantedResult = {
  id: string;
  caseId: string;
  answer: string;
  difficulty: Difficulty;
  flaw?: string;
  /** The judge failed the planted answer. null when the judge could not grade it. */
  caught: boolean | null;
  confidence: number | null;
  error?: string;
};

export type Tally = { passed: number; total: number };

export type JudgeSummary = {
  name: string;
  model: string | null;
  evaluated: number;
  /** Share of cases where the judge and the deterministic checker gave the same verdict. */
  agreementWithChecker: number | null;
  disagreements: string[];
  /** Cases where both agreed, but the judge was unsure (confidence below 0.6). Worth a look anyway. */
  lowConfidence: string[];
};

export type PlantedSummary = {
  total: number;
  caught: number;
  byDifficulty: Record<Difficulty, { total: number; caught: number }>;
  missed: string[];
  results: PlantedResult[];
};

export type HumanCheck = {
  reviewedAt: string | null;
  runAt: string;
  judge: string | null;
  reviewed: number;
  total: number;
  judgeAgreement: AgreementStats;
  checkerAgreement: AgreementStats;
  planted: { total: number; judgeCaught: number; humanCaught: number };
  disagreements: { key: string; human: boolean; judge: boolean; note: string }[];
};

export type Report = {
  tool: { name: "noxeval"; version: string };
  runAt: string;
  target: string;
  total: number;
  passed: number;
  categories: Record<string, Tally>;
  tags: Record<string, Tally>;
  latencyMs: { p50: number | null; p90: number | null };
  judge: JudgeSummary | null;
  planted: PlantedSummary | null;
  /** Last blind review of this run, written by `noxeval review`. */
  human: HumanCheck | null;
  cases: CaseResult[];
};

const LOW_CONFIDENCE = 0.6;

function tally(results: CaseResult[], keysOf: (r: CaseResult) => string[]): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const r of results)
    for (const key of keysOf(r)) {
      const t = (out[key] ??= { passed: 0, total: 0 });
      t.total++;
      if (r.passed) t.passed++;
    }
  return out;
}

export function summarizeJudge(name: string, results: CaseResult[]): JudgeSummary | null {
  const judged = results.filter((r): r is CaseResult & { judge: JudgeVerdict } => Boolean(r.judge));
  if (judged.length === 0) return null;
  const agree = judged.filter((r) => r.judge.pass === r.passed);
  return {
    name,
    model: judged.find((r) => r.judge.model)?.judge.model ?? null,
    evaluated: judged.length,
    agreementWithChecker: Math.round((agree.length / judged.length) * 1000) / 1000,
    disagreements: judged.filter((r) => r.judge.pass !== r.passed).map((r) => r.id),
    lowConfidence: agree.filter((r) => r.judge.confidence !== null && r.judge.confidence < LOW_CONFIDENCE).map((r) => r.id),
  };
}

export function summarizePlanted(results: PlantedResult[]): PlantedSummary | null {
  if (results.length === 0) return null;
  const byDifficulty: PlantedSummary["byDifficulty"] = { obvious: { total: 0, caught: 0 }, subtle: { total: 0, caught: 0 } };
  for (const p of results) {
    byDifficulty[p.difficulty].total++;
    if (p.caught) byDifficulty[p.difficulty].caught++;
  }
  return {
    total: results.length,
    caught: results.filter((p) => p.caught).length,
    byDifficulty,
    missed: results.filter((p) => p.caught === false).map((p) => p.id),
    results,
  };
}

export function buildReport(input: {
  version: string;
  runAt: string;
  target: string;
  judgeName: string | null;
  cases: CaseResult[];
  planted: PlantedResult[];
}): Report {
  const ms = input.cases.map((r) => r.ms).filter((v): v is number => typeof v === "number");
  return {
    tool: { name: "noxeval", version: input.version },
    runAt: input.runAt,
    target: input.target,
    total: input.cases.length,
    passed: input.cases.filter((r) => r.passed).length,
    categories: tally(input.cases, (r) => [r.category ?? "uncategorized"]),
    tags: tally(input.cases, (r) => r.tags ?? []),
    latencyMs: { p50: percentile(ms, 0.5), p90: percentile(ms, 0.9) },
    judge: input.judgeName ? summarizeJudge(input.judgeName, input.cases) : null,
    planted: summarizePlanted(input.planted),
    human: null,
    cases: input.cases,
  };
}
