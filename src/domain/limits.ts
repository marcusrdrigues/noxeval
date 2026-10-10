import type { EvalCase } from "./case.ts";
import type { CheckOptions, Failure } from "./checks.ts";
import { percentile } from "./agreement.ts";

/**
 * Cost and latency per case (0.6). A change can make the app slower or more expensive without making any answer
 * wrong; a limit per answer catches that. Both are usefulness failures: the answer was safe, it cost too much.
 * The app reports its cost (`costUsd`); noxeval never guesses prices.
 */

export type Limit = "cost" | "latency";

/** What one answer cost and how long it took. `ms` null means the target didn't time it (a recorded file without ms). */
export type Measured = { costUsd?: number; ms: number | null };

export type LimitsResult = {
  failures: Failure[];
  /** Limits set for the case that couldn't be checked: no cost reported, or no time measured. Never read as "within". */
  notChecked: Limit[];
};

/** A cost the app reported: a finite number, 0 or more. */
export const isUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Six decimals: enough for a fraction of a cent, and no float noise in a committed baseline. */
export const roundUsd = (v: number): number => Math.round(v * 1e6) / 1e6;

/** "$0.00123", "$0.0450", "$1.20": three significant digits below a dollar, cents above. */
export function formatUsd(v: number): string {
  if (v === 0) return "$0";
  if (v >= 1) return `$${v.toFixed(2)}`;
  const decimals = Math.min(6, 2 - Math.floor(Math.log10(v)));
  return `$${v.toFixed(decimals)}`;
}

/** The limits of one answer. The case's own limit wins over the run's. */
export function checkLimits(c: EvalCase, m: Measured, options: Pick<CheckOptions, "maxCostUsd" | "maxLatencyMs"> = {}): LimitsResult {
  const failures: Failure[] = [];
  const notChecked: Limit[] = [];
  const maxCost = c.maxCostUsd ?? options.maxCostUsd;
  if (maxCost !== undefined) {
    if (m.costUsd === undefined) notChecked.push("cost");
    else if (m.costUsd > maxCost) failures.push({ code: "over-cost", detail: `${formatUsd(m.costUsd)} > ${formatUsd(maxCost)}` });
  }
  const maxMs = c.maxLatencyMs ?? options.maxLatencyMs;
  if (maxMs !== undefined) {
    if (m.ms === null) notChecked.push("latency");
    else if (m.ms > maxMs) failures.push({ code: "over-latency", detail: `${m.ms} ms > ${maxMs} ms` });
  }
  return { failures, notChecked };
}

/** Cost across the answers of a run. Answers without a reported cost are counted, never taken as free. */
export type CostSummary = {
  /** Answers with a reported cost (every attempt, with repeat). */
  answers: number;
  /** Answers without one. */
  notReported: number;
  /** What the run spent: the sum over every attempt. */
  totalUsd: number;
  /** Per answer: what a baseline compares, so adding cases doesn't read as the app getting more expensive. */
  meanUsd: number;
  p90Usd: number;
};

/** null when no answer reported a cost. */
export function summarizeCost(costs: (number | undefined)[]): CostSummary | null {
  const reported = costs.filter(isUsd);
  if (reported.length === 0) return null;
  const total = reported.reduce((a, b) => a + b, 0);
  return {
    answers: reported.length,
    notReported: costs.length - reported.length,
    totalUsd: roundUsd(total),
    meanUsd: roundUsd(total / reported.length),
    p90Usd: roundUsd(percentile(reported, 0.9) ?? 0),
  };
}

/** Change from `before` to `now` in percent, one decimal; null when either is missing or `before` is 0. */
export function percentChange(before: number | null | undefined, now: number | null | undefined): number | null {
  if (before === null || before === undefined || now === null || now === undefined || before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}
