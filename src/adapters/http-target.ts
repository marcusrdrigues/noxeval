import type { EvalCase, ToolCall } from "../domain/case.ts";
import type { Target, TargetResponse } from "../ports.ts";
import { HttpError, pick, postJson } from "./http.ts";

export type HttpTargetOptions = {
  url: string;
  headers?: Record<string, string>;
  /** Request body for a case. Default: { question, locale, history }. */
  body?: (c: EvalCase) => unknown;
  /** Dot path of the answer in a JSON response (e.g. "answer" or "choices.0.message.content"). Omit for a plain-text response. */
  answerPath?: string;
  /** Dot path of the context the model received (an array of strings, or of objects with a "text" field). */
  contextPath?: string;
  /**
   * Dot path of the tool calls the app made (0.3). Each item is `{ name, args }`, `{ name, arguments }` or the
   * OpenAI shape `{ function: { name, arguments } }`, with arguments as an object or a JSON string.
   */
  toolCallsPath?: string;
  timeoutMs?: number;
  name?: string;
};

const asText = (item: unknown): string | null =>
  typeof item === "string"
    ? item
    : item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text
      : null;

const parseArgs = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

/** One reported tool call in any of the usual shapes, or null when it has no name. */
export function asToolCall(item: unknown): ToolCall | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const fn = o.function && typeof o.function === "object" ? (o.function as Record<string, unknown>) : null;
  const name = typeof o.name === "string" ? o.name : typeof fn?.name === "string" ? fn.name : null;
  if (!name) return null;
  const args = parseArgs(o.args ?? o.arguments ?? fn?.arguments);
  return args ? { name, args } : { name };
}

/** A target that POSTs each case as JSON and reads the answer from the response. */
export function httpTarget(options: HttpTargetOptions): Target {
  const body = options.body ?? ((c: EvalCase) => ({ question: c.question, locale: c.locale, history: c.history ?? [] }));
  return {
    name: options.name ?? new URL(options.url).host,
    async ask(c): Promise<TargetResponse> {
      const res = await postJson(options.url, body(c), options.headers ?? {}, options.timeoutMs ?? 60_000);
      if (!options.answerPath) return { answer: await res.text() };
      const json: unknown = await res.json().catch(() => {
        throw new HttpError("response is not JSON; set answerPath only for JSON responses");
      });
      const answer = pick(json, options.answerPath);
      if (typeof answer !== "string") throw new HttpError(`no string at "${options.answerPath}" in the response`);
      const raw = options.contextPath ? pick(json, options.contextPath) : undefined;
      const context = Array.isArray(raw) ? raw.map(asText).filter((t): t is string => t !== null) : undefined;
      let toolCalls: ToolCall[] | undefined;
      if (options.toolCallsPath) {
        const list = pick(json, options.toolCallsPath);
        if (list !== undefined && list !== null && !Array.isArray(list))
          throw new HttpError(`no array at "${options.toolCallsPath}" in the response`);
        toolCalls = list === undefined || list === null ? undefined : list.map(asToolCall).filter((t): t is ToolCall => t !== null);
      }
      return { answer, ...(context ? { context } : {}), ...(toolCalls ? { toolCalls } : {}) };
    },
  };
}

/** Wraps a plain async function as a target: the escape hatch for streaming, SDKs or anything custom. */
export function functionTarget(name: string, ask: (c: EvalCase) => Promise<TargetResponse | string>): Target {
  return {
    name,
    async ask(c) {
      const r = await ask(c);
      return typeof r === "string" ? { answer: r } : r;
    },
  };
}
