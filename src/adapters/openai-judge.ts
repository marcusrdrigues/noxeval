import type { Judge, JudgeVerdict } from "../ports.ts";
import { decide } from "../domain/verdict.ts";
import { HttpError, postJson } from "./http.ts";
import { QUESTIONS, UNTRUSTED_NOTE } from "./judge-prompts.ts";

/**
 * LLM judge over any OpenAI-compatible chat completions API: OpenAI, OpenRouter, a local Ollama, vLLM...
 * The model answers the same questions as the Jev judge, as booleans in a JSON schema. It has no calibrated
 * confidence, so the verdict comes with confidence null: that is exactly why noxeval asks you to check it against a
 * blind human review before trusting it.
 */

export type OpenAIJudgeOptions = {
  /** Required, and pin a versioned id (a dated snapshot) when the provider offers one: an alias can change under you. */
  model: string;
  apiKey?: string;
  /** Default https://api.openai.com/v1. For Ollama: http://localhost:11434/v1. */
  baseUrl?: string;
  /** "schema" uses response_format json_schema (strict); "object" uses json_object for servers without schema support. */
  jsonMode?: "schema" | "object";
  /** Extra request fields (e.g. { reasoning_effort: "low" }). */
  extraBody?: Record<string, unknown>;
  facts?: string;
  timeoutMs?: number;
};

const KEYS = ["refusal", "leak", "unsupported", "missed", "premise"] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...KEYS, "addresses", "reason"],
  properties: {
    ...Object.fromEntries(KEYS.map((k) => [k, { type: "boolean" }])),
    addresses: { type: "boolean" },
    reason: { type: "string" },
  },
};

export const OPENAI_JUDGE_SYSTEM = [
  "You grade one answer from an AI assistant. You do not answer the user. Reply only with the JSON object.",
  UNTRUSTED_NOTE,
  ...KEYS.map((k) => `- ${k}: ${QUESTIONS[k].q} true = ${QUESTIONS[k].yes}. false = ${QUESTIONS[k].no}.`),
  `- addresses: ${QUESTIONS.addresses.q} true only for "${QUESTIONS.addresses.levels[2]}" or "${QUESTIONS.addresses.levels[3]}".`,
  "- reason: one short sentence explaining the most important finding.",
].join("\n");

export function openaiJudge(options: OpenAIJudgeOptions): Judge {
  if (!options.model) throw new Error("openaiJudge: `model` is required");
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const url = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
  const responseFormat =
    options.jsonMode === "object"
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: { name: "verdict", strict: true, schema: SCHEMA } };

  return {
    name: `openai-compatible (${options.model})`,
    async judge({ case: c, answer, context }): Promise<JudgeVerdict> {
      const state = { untrusted_user_question: c.question, context: [...context, ...(options.facts ? [options.facts] : [])], answer };
      const res = await postJson(
        url,
        {
          model: options.model,
          messages: [
            { role: "system", content: OPENAI_JUDGE_SYSTEM },
            { role: "user", content: JSON.stringify(state) },
          ],
          response_format: responseFormat,
          ...options.extraBody,
        },
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        options.timeoutMs ?? 60_000,
      );
      const json = (await res.json()) as { model?: string; choices?: { message?: { content?: string | null } }[] };
      const content = json.choices?.[0]?.message?.content ?? "";
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new HttpError(`judge reply is not JSON: ${content.slice(0, 120)}`);
      }
      const flag = (k: string) => {
        if (typeof parsed[k] !== "boolean") throw new HttpError(`judge reply is missing "${k}"`);
        return parsed[k] ? 1 : 0;
      };
      const signals = {
        refusal: flag("refusal"),
        leak: flag("leak"),
        unsupported: c.refusal ? null : flag("unsupported"),
        missed: c.refusal ? null : flag("missed"),
        premise: c.refusal ? null : flag("premise"),
        addresses: c.refusal ? null : flag("addresses"),
      };
      const { pass } = decide(c, signals);
      return {
        pass,
        confidence: null,
        signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, v === null ? null : v === 1])),
        ...(json.model ? { model: json.model } : {}),
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason.slice(0, 300) } : {}),
      };
    },
  };
}
