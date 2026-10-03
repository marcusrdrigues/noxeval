import type { Judge, JudgeVerdict } from "../ports.ts";
import { decide } from "../domain/verdict.ts";
import { postJson } from "./http.ts";
import { QUESTIONS, UNTRUSTED_NOTE } from "./judge-prompts.ts";

/**
 * Judge on Jev (TypeSafe), a "System One" model: it doesn't write text, it answers typed questions with calibrated
 * probabilities. Docs: https://docs.typesafe.ai
 */

/** Pinned on purpose: an alias like "jev-latest" moves to a new version on its own and silently shifts your verdicts. */
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

export type JevJudgeOptions = {
  apiKey?: string;
  /** A versioned id. Default DEFAULT_JEV_MODEL. */
  model?: string;
  baseUrl?: string;
  /** Facts that are always true for your app (contact, product name...), added to the context of every case. */
  facts?: string;
  timeoutMs?: number;
};

type Answer = { type: "noul"; noul: number } | { type: "score"; score: number; confidence: number };
type JevResponse = { model?: string; answers: Record<string, Answer> };

const noul = (a: Answer | undefined): number => (a?.type === "noul" ? a.noul : 0);

export function jevJudge(options: JevJudgeOptions = {}): Judge {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const url = `${(options.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "")}/v1/systemone`;
  const timeout = options.timeoutMs ?? 30_000;

  async function ask(state: unknown, questions: Record<string, unknown>): Promise<JevResponse> {
    if (!apiKey) throw new Error("jevJudge: set TYPESAFE_API_KEY or pass apiKey");
    const res = await postJson(url, { model, state, questions }, { authorization: `Bearer ${apiKey}` }, timeout);
    return (await res.json()) as JevResponse;
  }
  const noulQ = (k: "refusal" | "leak" | "unsupported" | "missed" | "premise") => ({
    type: "noul",
    instructions: QUESTIONS[k].q,
    criteria: { true: QUESTIONS[k].yes, false: QUESTIONS[k].no },
  });

  return {
    name: `jev (${model})`,
    async judge({ case: c, answer, context }): Promise<JudgeVerdict> {
      // Refusal and leak look at the answer alone: with the question in the state, a question asking for the prompt
      // made refusals look like leaks.
      const onlyAnswer = ask(answer, { refusal: noulQ("refusal"), leak: noulQ("leak") });
      const withContext = c.refusal
        ? null
        : ask(
            {
              untrusted_user_question: c.question,
              context: [...context, ...(options.facts ? [options.facts] : [])],
              answer,
              note: UNTRUSTED_NOTE,
            },
            {
              unsupported: noulQ("unsupported"),
              missed: noulQ("missed"),
              premise: noulQ("premise"),
              addresses: { type: "score", instructions: QUESTIONS.addresses.q, criteria: [...QUESTIONS.addresses.levels] },
            },
          );
      const [a, b] = await Promise.all([onlyAnswer, withContext]);
      const score = b?.answers.addresses;
      const addresses = score?.type === "score" ? score.score / (QUESTIONS.addresses.levels.length - 1) : null;
      const signals = {
        refusal: noul(a.answers.refusal),
        leak: noul(a.answers.leak),
        unsupported: b ? noul(b.answers.unsupported) : null,
        missed: b ? noul(b.answers.missed) : null,
        premise: b ? noul(b.answers.premise) : null,
        addresses,
      };
      const v = decide(c, signals, score?.type === "score" ? score.confidence : null);
      const served = a.model ?? b?.model;
      return { ...v, signals, ...(served ? { model: served } : {}) };
    },
  };
}
