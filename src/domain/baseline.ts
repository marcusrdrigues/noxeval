import { failureKind, type FailureCode } from "./checks.ts";
import type { CaseResult, Report } from "./report.ts";

/**
 * Baseline and regression (0.6). A suite with one known-flaky case fails every run, people learn to ignore the red,
 * and a real regression slips through. So the question changes from "does every case pass?" to "did anything get
 * worse than the last run we accepted?". The accepted run is a small file the team commits, like a lockfile: it only
 * changes with `noxeval baseline update`, in a reviewed change.
 */

/** One case as accepted: its verdict, the codes it failed with and, with repeat, its pass rate. Never the answer. */
export type BaselineCase = { id: string; passed: boolean; failures: FailureCode[]; passRate?: number };

export type Baseline = {
  tool: { name: "noxeval"; version: string };
  kind: "noxeval-baseline";
  /** Bumped when the shape changes, so an old file is read on purpose, never by accident. */
  format: 1;
  /** The run this baseline was taken from. */
  runAt: string;
  target: string;
  repeat: number;
  total: number;
  passed: number;
  latencyMs: { p50: number | null; p90: number | null };
  /** Sorted by id, so an update shows as a small, readable diff. */
  cases: BaselineCase[];
};

export type Regression = { id: string; reason: string };

/** A run compared with the accepted baseline. */
export type Comparison = {
  baseline: { runAt: string; target: string; repeat: number; version: string };
  /** No regression: the run passes the gate, whatever the known failures. */
  passed: boolean;
  /** Passed in the baseline and fails now, a new safety failure code, or a new case that fails. These fail the run. */
  regressed: Regression[];
  /** Failed in the baseline, pass now. Until the baseline is updated, they are not guarded. */
  fixed: string[];
  /** Failed in the baseline and still fail, with no new safety failure. Listed, never silent, but they don't fail the run. */
  knownFailures: string[];
  /** Passed some attempts and failed others in this run (with repeat). */
  flaky: string[];
  /** Cases the baseline doesn't have. A failing one is also in `regressed`. */
  new: { id: string; passed: boolean }[];
  /** Cases of the baseline this run didn't have. Empty for a partial run (`--only`). */
  removed: string[];
  /** Passed in both. */
  unchanged: number;
  /** Differences that don't invalidate the comparison but are worth knowing (another target, another repeat). */
  warnings: string[];
};

const codesOf = (failures: { code: FailureCode }[]): FailureCode[] => [...new Set(failures.map((f) => f.code))].sort();

function toBaselineCase(r: CaseResult): BaselineCase {
  return { id: r.id, passed: r.passed, failures: codesOf(r.failures), ...(r.passRate !== undefined ? { passRate: r.passRate } : {}) };
}

/**
 * The baseline of a report: ids, verdicts, failure codes and pass rates. A partial run (`--only`) is refused: accepting
 * it would drop every case that didn't run.
 */
export function toBaseline(report: Report): Baseline {
  if (report.partial) throw new Error("this report comes from a partial run (--only); run every case before accepting it as the baseline");
  return {
    tool: { name: "noxeval", version: report.tool.version },
    kind: "noxeval-baseline",
    format: 1,
    runAt: report.runAt,
    target: report.target,
    repeat: report.repeat ?? 1,
    total: report.total,
    passed: report.passed,
    latencyMs: report.latencyMs,
    cases: report.cases.map(toBaselineCase).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads a baseline file, or a full report (taken as its baseline), already parsed from JSON. Comparing with the
 * report of the last CI run then needs no extra step.
 */
export function parseBaseline(raw: unknown, file = "baseline"): Baseline {
  if (isObject(raw) && raw.kind === "noxeval-baseline") {
    if (raw.format !== 1) throw new Error(`${file}: baseline format ${String(raw.format)} is not supported by this version`);
    const ok =
      Array.isArray(raw.cases) &&
      raw.cases.every((c) => isObject(c) && typeof c.id === "string" && typeof c.passed === "boolean" && Array.isArray(c.failures));
    if (!ok) throw new Error(`${file}: every baseline case needs "id", "passed" and "failures"`);
    return raw as Baseline;
  }
  if (isObject(raw) && isObject(raw.tool) && raw.tool.name === "noxeval" && Array.isArray(raw.cases))
    return toBaseline(raw as unknown as Report);
  throw new Error(`${file}: not a noxeval baseline or report; create one with: npx noxeval baseline update`);
}

const rate = (c: { passRate?: number }) => (c.passRate === undefined ? "" : ` (pass rate ${Math.round(c.passRate * 100)}%)`);

/**
 * Compares a run with the accepted baseline, case by case, on verdicts and failure codes:
 * - passed before, fails now: regressed;
 * - failed before, fails now with a safety code it didn't have: regressed (a known usefulness failure that turns into
 *   an invented source is worse, not the same);
 * - failed before, fails now otherwise: a known failure, listed but not failing the run;
 * - a new case that fails: regressed, since nobody accepted that failure.
 * Codes, not details: `[x]` becoming `[y]` is the same failure. The judge and planted errors stay out of the gate:
 * the judge checks the checks, it is not the verdict.
 */
export function compareReports(baseline: Baseline, current: Report): Comparison {
  const before = new Map(baseline.cases.map((c) => [c.id, c]));
  const out: Comparison = {
    baseline: { runAt: baseline.runAt, target: baseline.target, repeat: baseline.repeat, version: baseline.tool.version },
    passed: true,
    regressed: [],
    fixed: [],
    knownFailures: [],
    flaky: current.flaky ?? [],
    new: [],
    removed: [],
    unchanged: 0,
    warnings: [],
  };
  for (const now of current.cases) {
    const codes = codesOf(now.failures);
    const was = before.get(now.id);
    if (!was) {
      out.new.push({ id: now.id, passed: now.passed });
      if (!now.passed) out.regressed.push({ id: now.id, reason: `new case, fails: ${codes.join(", ")}` });
      continue;
    }
    if (was.passed && now.passed) out.unchanged++;
    else if (was.passed)
      out.regressed.push({ id: now.id, reason: `passed in the baseline${rate(was)}, fails now: ${codes.join(", ")}${rate(now)}` });
    else if (now.passed) out.fixed.push(now.id);
    else {
      const newSafety = codes.filter((c) => failureKind(c) === "safety" && !was.failures.includes(c));
      if (newSafety.length) out.regressed.push({ id: now.id, reason: `new safety failure: ${newSafety.join(", ")}` });
      else out.knownFailures.push(now.id);
    }
  }
  // A partial run compares only what it ran: the other cases are not "removed".
  if (!current.partial) {
    const ran = new Set(current.cases.map((c) => c.id));
    out.removed = baseline.cases.filter((c) => !ran.has(c.id)).map((c) => c.id);
  }
  if (baseline.target !== current.target)
    out.warnings.push(`the baseline was taken against ${baseline.target}, this run against ${current.target}`);
  const repeat = current.repeat ?? 1;
  if (baseline.repeat !== repeat) out.warnings.push(`the baseline asked each case ${baseline.repeat} time(s), this run ${repeat}`);
  out.passed = out.regressed.length === 0;
  return out;
}
