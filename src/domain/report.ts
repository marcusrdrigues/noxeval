import type { Difficulty, ToolCall } from "./case.ts";
import type { Attempt } from "./variance.ts";
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
  /** Tool calls the app reported for this case (0.3). */
  toolCalls?: ToolCall[];
  /** With repeat > 1 (0.4): every attempt, the first one's verdict, the pass rate and its 95% Wilson lower bound. */
  attempts?: Attempt[];
  firstPassed?: boolean;
  passRate?: number;
  passRateLow?: number;
  judge?: JudgeVerdict | null;
  judgeError?: string;
  /**
   * Ungrounded details of the first attempt (0.5), when grounding is on. `checked` is false when the target returned
   * no context: never read that as grounded.
   */
  grounding?: { checked: boolean; details: string[] };
  /**
   * Citations of the first attempt (0.6), when the check applies: the source ids the target reported (null when it
   * reported none) and the ids the answer cited. Ids only, never the passages.
   */
  citations?: { sources: string[] | null; cited: string[] };
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
  /** Tool calls across the run (0.3): count per tool and how many cases called any. Null when no case reported calls. */
  tools?: ToolsSummary | null;
  /** Last blind review of this run, written by `noxeval review`. */
  human: HumanCheck | null;
  /** Times each case was asked (0.4); absent in older reports means 1. */
  repeat?: number;
  /** Cases that passed some attempts and failed others (0.4). */
  flaky?: string[];
  /** Ungrounded details (0.5); absent when grounding is off. */
  grounding?: GroundingSummary;
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
  // The judge graded the first attempt, so it is compared with that attempt's verdict (0.4).
  const first = (r: CaseResult) => r.firstPassed ?? r.passed;
  const agree = judged.filter((r) => r.judge.pass === first(r));
  return {
    name,
    model: judged.find((r) => r.judge.model)?.judge.model ?? null,
    evaluated: judged.length,
    agreementWithChecker: Math.round((agree.length / judged.length) * 1000) / 1000,
    disagreements: judged.filter((r) => r.judge.pass !== first(r)).map((r) => r.id),
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

export type ToolsSummary = { calls: Record<string, number>; cases: number };

/** Ungrounded details across the run (0.5). */
export type GroundingSummary = {
  mode: "report" | "check";
  /** Answers checked: grounding on for the case and context returned. */
  checked: number;
  /** Answers not checked because the target returned no context. */
  notChecked: number;
  withUngrounded: number;
  cases: { id: string; details: string[] }[];
};

export function summarizeGrounding(mode: "report" | "check", results: CaseResult[]): GroundingSummary {
  const on = results.filter((r) => r.grounding);
  const flagged = on.filter((r) => r.grounding?.checked && r.grounding.details.length > 0);
  return {
    mode,
    checked: on.filter((r) => r.grounding?.checked).length,
    notChecked: on.filter((r) => !r.grounding?.checked).length,
    withUngrounded: flagged.length,
    cases: flagged.map((r) => ({ id: r.id, details: r.grounding?.details ?? [] })),
  };
}

export function summarizeTools(results: CaseResult[]): ToolsSummary | null {
  const reported = results.filter((r) => r.toolCalls !== undefined);
  if (reported.length === 0) return null;
  const calls: Record<string, number> = {};
  for (const r of reported) for (const c of r.toolCalls ?? []) calls[c.name] = (calls[c.name] ?? 0) + 1;
  return { calls, cases: reported.filter((r) => (r.toolCalls ?? []).length > 0).length };
}

export function buildReport(input: {
  version: string;
  runAt: string;
  target: string;
  judgeName: string | null;
  cases: CaseResult[];
  planted: PlantedResult[];
  repeat?: number;
  grounding?: "off" | "report" | "check";
}): Report {
  // Latency over every attempt: more samples, same meaning.
  const ms = input.cases
    .flatMap((r) => (r.attempts ? r.attempts.map((a) => a.ms) : [r.ms]))
    .filter((v): v is number => typeof v === "number");
  const repeat = input.repeat ?? 1;
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
    tools: summarizeTools(input.cases),
    human: null,
    ...(repeat > 1
      ? { repeat, flaky: input.cases.filter((r) => r.passRate !== undefined && r.passRate > 0 && r.passRate < 1).map((r) => r.id) }
      : {}),
    ...(input.grounding && input.grounding !== "off" ? { grounding: summarizeGrounding(input.grounding, input.cases) } : {}),
    cases: input.cases,
  };
}
