import { agreementStats } from "./agreement.ts";
import type { HumanCheck, Report } from "./report.ts";

/**
 * Blind human review. The reviewer sees the question, what a correct answer looks like and the answer; never the
 * judge's or the checker's verdict, so the grading can't lean on them (anchoring bias). Planted errors are mixed in
 * unmarked, which is what gives the sample wrong answers to catch.
 */

export type ReviewItem = {
  key: string;
  kind: "real" | "planted";
  caseId: string;
  locale?: string;
  question: string;
  expect?: string;
  answer: string;
  /** null until graded. */
  human: boolean | null;
  note: string;
  /** Filled only after the human grades the item. */
  judge?: boolean | null;
  checker?: boolean | null;
};

export type ReviewFile = {
  runAt: string;
  judge: string | null;
  startedAt: string;
  reviewedAt: string | null;
  items: ReviewItem[];
};

/** The verdicts kept out of the review file until the human answers. */
export type HiddenVerdicts = Map<string, { judge: boolean | null; checker: boolean | null }>;

/** Seeded pseudo-random generator (mulberry32): the same run always gives the same order. */
function seeded(text: string): () => number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(list: T[], seed: string): T[] {
  const rand = seeded(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Items for a blind review of one run: each distinct answer once (twenty identical refusals are one item) plus every
 * planted error the judge graded, shuffled with the run time as the seed. Verdicts come back separately.
 */
export function buildReview(report: Report, now: string): { review: ReviewFile; hidden: HiddenVerdicts } {
  const hidden: HiddenVerdicts = new Map();
  const items: ReviewItem[] = [];
  const seen = new Set<string>();
  for (const r of report.cases) {
    const answer = r.answer.trim();
    if (!answer || seen.has(answer)) continue;
    seen.add(answer);
    items.push({
      key: r.id,
      kind: "real",
      caseId: r.id,
      locale: r.locale,
      question: r.question,
      expect: r.expect,
      answer,
      human: null,
      note: "",
    });
    hidden.set(r.id, { judge: r.judge ? r.judge.pass : null, checker: r.passed });
  }
  const byId = new Map(report.cases.map((r) => [r.id, r]));
  for (const p of report.planted?.results ?? []) {
    const c = byId.get(p.caseId);
    if (!c || p.caught === null) continue;
    items.push({
      key: p.id,
      kind: "planted",
      caseId: p.caseId,
      locale: c.locale,
      question: c.question,
      expect: c.expect,
      answer: p.answer,
      human: null,
      note: "",
    });
    hidden.set(p.id, { judge: !p.caught, checker: null });
  }
  return {
    review: {
      runAt: report.runAt,
      judge: report.judge?.name ?? null,
      startedAt: now,
      reviewedAt: null,
      items: shuffle(items, report.runAt),
    },
    hidden,
  };
}

/** Records one grade and only then reveals that item's judge and checker verdicts into the file. */
export function grade(review: ReviewFile, key: string, human: boolean, note: string, hidden: HiddenVerdicts, now: string): void {
  const item = review.items.find((i) => i.key === key);
  if (!item) throw new Error(`unknown review item: ${key}`);
  const v = hidden.get(key);
  item.human = human;
  item.note = human ? "" : note.trim().slice(0, 300);
  item.judge = v?.judge ?? null;
  item.checker = v?.checker ?? null;
  review.reviewedAt = now;
}

/** Agreement of the judge and the checker with the human, over the graded items only. */
export function summarizeReview(review: ReviewFile): HumanCheck | null {
  const graded = review.items.filter((i): i is ReviewItem & { human: boolean } => typeof i.human === "boolean");
  if (graded.length === 0) return null;
  const withJudge = graded.filter((i): i is typeof i & { judge: boolean } => typeof i.judge === "boolean");
  const withChecker = graded.filter((i): i is typeof i & { checker: boolean } => i.kind === "real" && typeof i.checker === "boolean");
  const planted = graded.filter((i) => i.kind === "planted");
  return {
    reviewedAt: review.reviewedAt,
    runAt: review.runAt,
    judge: review.judge,
    reviewed: graded.length,
    total: review.items.length,
    judgeAgreement: agreementStats(withJudge.map((i) => ({ human: i.human, rater: i.judge }))),
    checkerAgreement: agreementStats(withChecker.map((i) => ({ human: i.human, rater: i.checker }))),
    planted: {
      total: planted.length,
      judgeCaught: planted.filter((i) => i.judge === false).length,
      humanCaught: planted.filter((i) => !i.human).length,
    },
    disagreements: withJudge.filter((i) => i.human !== i.judge).map((i) => ({ key: i.key, human: i.human, judge: i.judge, note: i.note })),
  };
}
