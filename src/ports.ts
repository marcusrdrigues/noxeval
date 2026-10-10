import type { EvalCase, ToolCall } from "./domain/case.ts";
import type { Source } from "./domain/citations.ts";

/**
 * The two seams of noxeval. Anything that answers a question is a Target; anything that grades an answer is a Judge.
 * Adapters for HTTP, Jev and OpenAI-compatible APIs live in src/adapters; a plain function works too.
 */

export type TargetResponse = {
  answer: string;
  /** What the model received to answer (RAG passages, tool results). The judge checks the answer against it. */
  context?: string[];
  /**
   * Tool calls the app made, in order (0.3). Return [] when it called none: a missing field means "can't verify",
   * and cases with trajectory checks then fail with `no-trajectory`.
   */
  toolCalls?: ToolCall[];
  /**
   * Sources the model received, with the ids the answer cites them by (0.6). When `context` is absent, the sources'
   * texts become the context, so grounding and the judge see them. A missing field means "can't verify": cases with
   * `mustCite` then fail with `no-sources`.
   */
  sources?: Source[];
  /**
   * Time the app took, in ms, measured by the app itself (0.6): time inside the app, without the network, or the time
   * recorded with an answer read from a file. Overrides noxeval's own clock; null means "not measured", so a file read
   * in 0 ms never shows up as a 0 ms latency.
   */
  ms?: number | null;
  /**
   * What this answer cost the app, in US dollars (0.6): model tokens plus anything else per answer (the query
   * embedding, a reranker). noxeval never guesses prices; without it, cost limits are "not checked".
   */
  costUsd?: number;
  /** Anything worth keeping in the report for this case (request id, model that answered...). */
  meta?: Record<string, string | number | boolean | null>;
};

export interface Target {
  /** Shown in the report. */
  readonly name: string;
  /**
   * Optional (0.6): called once before the first case, with every case of the suite (not only the ones this run asks,
   * with `--only`). Throwing stops the run before any case, for a problem every case would hit (a broken answers
   * file). The strings it returns are notes for the report ("3 ids match no case").
   */
  prepare?(suite: EvalCase[]): Promise<string[] | undefined>;
  ask(c: EvalCase): Promise<TargetResponse>;
}

/**
 * Thrown by a target that has no answer for a case (0.6), e.g. a recorded-answers file without its id. The case fails
 * with `no-answer` instead of `error`: the app gave nothing to grade, the adapter didn't break.
 */
export class NoAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAnswerError";
  }
}

export type JudgeInput = {
  case: EvalCase;
  answer: string;
  context: string[];
};

export type JudgeVerdict = {
  pass: boolean;
  /** 0 (coin flip) to 1 (certain). null when the judge has no calibrated confidence. */
  confidence: number | null;
  /** The raw signals behind the verdict (probabilities or booleans), for the report. */
  signals: Record<string, number | boolean | null>;
  /** The model that actually answered, when the API says so. */
  model?: string;
  reason?: string;
};

export interface Judge {
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}
