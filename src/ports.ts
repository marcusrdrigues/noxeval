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
  /** Anything worth keeping in the report for this case (request id, model that answered...). */
  meta?: Record<string, string | number | boolean | null>;
};

export interface Target {
  /** Shown in the report. */
  readonly name: string;
  ask(c: EvalCase): Promise<TargetResponse>;
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
