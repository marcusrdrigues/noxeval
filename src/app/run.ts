import type { EvalCase, PlantedError } from "../domain/case.ts";
import { check, type CheckOptions } from "../domain/checks.ts";
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

  const results = await pool(o.cases, o.concurrency ?? 1, async (c): Promise<CaseResult> => {
    const base = { id: c.id, question: c.question, expect: c.expect, locale: c.locale, category: c.category, tags: c.tags };
    o.onStart?.(c, ++inFlight);
    const t0 = performance.now();
    let result: CaseResult;
    try {
      const r = await o.target.ask(c);
      const ms = Math.round(performance.now() - t0);
      const context = r.context ?? [];
      contexts.set(c.id, context);
      const failures = check(c, r.answer, o.checks);
      result = {
        ...base,
        passed: failures.length === 0,
        failures,
        answer: r.answer,
        contextSize: context.length,
        ms,
        ...(r.meta ? { meta: r.meta } : {}),
      };
      if (o.judge) {
        try {
          result.judge = await o.judge.judge({ case: c, answer: r.answer, context });
        } catch (err) {
          result.judge = null;
          result.judgeError = message(err);
        }
      }
    } catch (err) {
      result = { ...base, passed: false, failures: [{ code: "error", detail: message(err) }], answer: "", contextSize: 0, ms: null };
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

  return buildReport({ version: VERSION, runAt, target: o.target.name, judgeName: o.judge?.name ?? null, cases: results, planted });
}
