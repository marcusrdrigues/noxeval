import type { EvalCase, PlantedError } from "../domain/case.ts";
import { summarizeAttempts, type Attempt } from "../domain/variance.ts";
import { check, type CheckOptions } from "../domain/checks.ts";
import { checkTrajectory } from "../domain/trajectory.ts";
import { ungroundedDetails } from "../domain/grounding.ts";
import { checkCitations, citationPattern, citationsApply, citedIds } from "../domain/citations.ts";
import { buildReport, type CaseResult, type PlantedResult, type Report } from "../domain/report.ts";
import type { Judge, Target } from "../ports.ts";
import { VERSION } from "../version.ts";

export type RunOptions = {
  target: Target;
  cases: EvalCase[];
  checks?: CheckOptions;
  /** Optional. Without a judge, planted errors are skipped (there is nothing to measure). */
  judge?: Judge | null;
  planted?: PlantedError[];
  /** Times each case is asked (0.4). Default 1. With more, the report has a pass rate per case and the flaky ones. */
  repeat?: number;
  /** With `repeat`: share of attempts that must pass (default 1). Safety failures fail the case in any attempt. */
  minPassRate?: number;
  /** Cases asked at the same time. Default 1: gentle on rate limits and quotas. */
  concurrency?: number;
  /** A case was sent to the target (for progress displays). */
  onStart?: (c: EvalCase, inFlight: number) => void;
  onCase?: (result: CaseResult, done: number, total: number) => void;
  onPlanted?: (result: PlantedResult) => void;
  now?: () => Date;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}

/**
 * Runs every case against the target: deterministic checks first, then the judge (if any), then the planted errors,
 * graded with the context the target returned for their case. A failing target or judge never stops the run:
 * the case fails with the error, so one flaky call doesn't hide the other results.
 */
export async function runEval(o: RunOptions): Promise<Report> {
  const now = o.now ?? (() => new Date());
  const runAt = now().toISOString();
  const contexts = new Map<string, string[]>();
  let done = 0;
  let inFlight = 0;

  const repeat = Math.max(1, Math.floor(o.repeat ?? 1));
  // A broken pattern fails the run before any call, not every case with a confusing "error".
  citationPattern(o.checks?.citations?.pattern);
  const groundingMode = o.checks?.grounding ?? "off";

  /** Ungrounded details of one answer (0.5); null when the case skips the check or the target sent no context. */
  function grounding(c: EvalCase, answer: string, context: string[] | undefined) {
    if (groundingMode === "off" || c.grounding === false) return undefined;
    if (!context) return { checked: false, details: [] as string[] };
    const allow = o.checks?.groundingAllow;
    const details = ungroundedDetails(answer, context, { question: c.question, ...(allow ? { allow } : {}) }).map((d) => d.text);
    return { checked: true, details: [...new Set(details)] };
  }

  /** One ask of one case: answer checks and trajectory checks. A failing target becomes an "error" failure. */
  async function attempt(c: EvalCase) {
    const t0 = performance.now();
    try {
      const r = await o.target.ask(c);
      // An explicit context wins; without one, the sources' texts are what the model received (0.6).
      const context = r.context ?? r.sources?.map((s) => s.text);
      const g = grounding(c, r.answer, context);
      const citations = citationsApply(c, r.sources)
        ? { sources: r.sources?.map((s) => s.id) ?? null, cited: citedIds(r.answer, o.checks?.citations) }
        : undefined;
      const failures = [
        ...check(c, r.answer, o.checks),
        ...checkTrajectory(c, r.toolCalls),
        ...checkCitations(r.answer, r.sources, c, o.checks?.citations),
        // In "check" mode, an ungrounded detail fails the attempt; in "report" mode it is only recorded.
        ...(groundingMode === "check" && g?.checked && g.details.length
          ? [{ code: "ungrounded" as const, detail: g.details.join(", ") }]
          : []),
      ];
      return { ok: true as const, r, context, ms: Math.round(performance.now() - t0), failures, grounding: g, citations };
    } catch (err) {
      return { ok: false as const, error: message(err) };
    }
  }

  const results = await pool(o.cases, o.concurrency ?? 1, async (c): Promise<CaseResult> => {
    const base = { id: c.id, question: c.question, expect: c.expect, locale: c.locale, category: c.category, tags: c.tags };
    o.onStart?.(c, ++inFlight);
    let result: CaseResult;
    const first = await attempt(c);
    if (first.ok) {
      const { r, ms, failures } = first;
      const context = first.context ?? [];
      contexts.set(c.id, context);
      result = {
        ...base,
        passed: failures.length === 0,
        failures,
        answer: r.answer,
        contextSize: context.length,
        ms,
        ...(r.toolCalls ? { toolCalls: r.toolCalls } : {}),
        ...(r.meta ? { meta: r.meta } : {}),
        ...(first.grounding ? { grounding: first.grounding } : {}),
        ...(first.citations ? { citations: first.citations } : {}),
      };
      // The judge grades the first attempt only: it checks the checks, it doesn't measure variance (0.4).
      if (o.judge) {
        try {
          result.judge = await o.judge.judge({ case: c, answer: r.answer, context });
        } catch (err) {
          result.judge = null;
          result.judgeError = message(err);
        }
      }
    } else {
      result = { ...base, passed: false, failures: [{ code: "error", detail: first.error }], answer: "", contextSize: 0, ms: null };
    }
    if (repeat > 1) {
      const attempts: Attempt[] = [
        {
          passed: result.passed,
          failures: result.failures,
          ms: result.ms,
          answer: result.answer,
          ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
        },
      ];
      for (let i = 1; i < repeat; i++) {
        const a = await attempt(c);
        attempts.push(
          a.ok
            ? {
                passed: a.failures.length === 0,
                failures: a.failures,
                ms: a.ms,
                answer: a.r.answer,
                ...(a.r.toolCalls ? { toolCalls: a.r.toolCalls } : {}),
              }
            : { passed: false, failures: [{ code: "error", detail: a.error }], ms: null, answer: "" },
        );
      }
      const s = summarizeAttempts(attempts, c.minPassRate ?? o.minPassRate ?? 1);
      // The fields of the first attempt stay as they are (judge, review); the verdict and the reasons cover all attempts.
      result = {
        ...result,
        firstPassed: result.passed,
        passed: s.passed,
        failures: s.failures,
        attempts,
        passRate: s.passRate,
        passRateLow: s.passRateLow,
      };
    }
    inFlight--;
    o.onCase?.(result, ++done, o.cases.length);
    return result;
  });

  const planted: PlantedResult[] = [];
  if (o.judge && o.planted?.length) {
    const byId = new Map(o.cases.map((c) => [c.id, c]));
    for (const p of o.planted) {
      const c = byId.get(p.caseId);
      if (!c) continue;
      const base = {
        id: p.id,
        caseId: p.caseId,
        answer: p.answer,
        difficulty: p.difficulty ?? "obvious",
        ...(p.flaw ? { flaw: p.flaw } : {}),
      } as const;
      let r: PlantedResult;
      try {
        const v = await o.judge.judge({ case: c, answer: p.answer, context: contexts.get(p.caseId) ?? [] });
        r = { ...base, caught: !v.pass, confidence: v.confidence };
      } catch (err) {
        r = { ...base, caught: null, confidence: null, error: message(err) };
      }
      planted.push(r);
      o.onPlanted?.(r);
    }
  }

  return buildReport({
    version: VERSION,
    runAt,
    target: o.target.name,
    judgeName: o.judge?.name ?? null,
    cases: results,
    planted,
    repeat,
    grounding: groundingMode,
  });
}
