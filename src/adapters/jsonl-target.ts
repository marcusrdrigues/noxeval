import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase, ToolCall } from "../domain/case.ts";
import type { Source } from "../domain/citations.ts";
import { NoAnswerError, type Target, type TargetResponse } from "../ports.ts";
import { asSource, asText, asToolCall } from "./http-target.ts";

/**
 * Recorded answers (0.6): the app generates its answers with its own code path (its prompts, adapters and caches) and
 * writes them to a file, one JSON object per line; noxeval grades the file. The app can be written in any language and
 * needs no test endpoint.
 *
 * ```jsonl
 * {"id": "cdc-6", "answer": "Yes, see [cdc-art-6].", "sources": [{"id": "cdc-art-6", "text": "Art. 6 ..."}], "ms": 840}
 * ```
 */

export type JsonlTargetOptions = {
  /** Field of each line that holds the case id. Default "id". */
  idField?: string;
  /** Shown in the report. Default: the file name. */
  name?: string;
};

/** Problems listed in one error, so a broken file is fixed in one pass. Past this, "and N more". */
const MAX_PROBLEMS = 20;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isScalarOrNull = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const isNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** One line as a response, or the problems that keep it from being one. */
function toResponse(o: Record<string, unknown>, at: string): { response?: TargetResponse; problems: string[] } {
  const problems: string[] = [];
  if (typeof o.answer !== "string") problems.push(`${at}: "answer" must be a string`);

  let context: string[] | undefined;
  if (o.context !== undefined) {
    const texts = Array.isArray(o.context) ? o.context.map(asText) : null;
    if (!texts || texts.some((t) => t === null)) problems.push(`${at}: "context" must be an array of strings or { text } objects`);
    else context = texts as string[];
  }

  let sources: Source[] | undefined;
  if (o.sources !== undefined) {
    if (!Array.isArray(o.sources)) problems.push(`${at}: "sources" must be an array of { id, text }`);
    else {
      const list = o.sources.map(asSource);
      const bad = list.findIndex((s) => s === null);
      if (bad >= 0) problems.push(`${at}: source #${bad + 1} needs an "id" (string or number) and a "text"`);
      else sources = list as Source[];
    }
  }

  let toolCalls: ToolCall[] | undefined;
  if (o.toolCalls !== undefined) {
    const list = Array.isArray(o.toolCalls) ? o.toolCalls.map(asToolCall) : null;
    if (!list || list.some((t) => t === null)) problems.push(`${at}: "toolCalls" must be an array of calls with a "name"`);
    else toolCalls = list as ToolCall[];
  }

  if (o.meta !== undefined && !(isObject(o.meta) && Object.values(o.meta).every(isScalarOrNull)))
    problems.push(`${at}: "meta" must be an object of strings, numbers, booleans or null`);
  if (o.ms !== undefined && o.ms !== null && !isNonNegative(o.ms)) problems.push(`${at}: "ms" must be a number, 0 or more`);
  // Read now so a recorded file stays valid; the cost checks themselves come with the cost and latency limits.
  if (o.costUsd !== undefined && !isNonNegative(o.costUsd)) problems.push(`${at}: "costUsd" must be a number, 0 or more`);

  if (problems.length) return { problems };
  return {
    problems,
    response: {
      answer: o.answer as string,
      ...(context ? { context } : {}),
      ...(sources ? { sources } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(o.meta !== undefined ? { meta: o.meta as TargetResponse["meta"] } : {}),
      // A line without "ms" was not timed: null keeps a 0 ms file read out of the latency numbers.
      ms: isNonNegative(o.ms) ? o.ms : null,
    },
  };
}

/**
 * Parses a recorded-answers file: one JSON object per line, blank lines skipped, a byte-order mark and Windows line
 * endings accepted (PowerShell and some editors write them). Lines with the same id are kept in order, one per attempt.
 * Throws one error listing every problem.
 */
export function parseJsonl(text: string, file: string, idField = "id"): Map<string, TargetResponse[]> {
  const byId = new Map<string, TargetResponse[]>();
  const problems: string[] = [];
  (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const at = `line ${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return problems.push(`${at}: not valid JSON`);
    }
    if (!isObject(value)) return problems.push(`${at}: must be a JSON object`);
    const rawId = value[idField];
    const id = typeof rawId === "number" ? String(rawId) : typeof rawId === "string" ? rawId.trim() : "";
    if (!id) return problems.push(`${at}: "${idField}" is required (a string or a number)`);
    const { response, problems: found } = toResponse(value, `${at} (${id})`);
    problems.push(...found);
    if (response) byId.set(id, [...(byId.get(id) ?? []), response]);
  });
  if (problems.length) {
    const shown = problems.slice(0, MAX_PROBLEMS);
    if (problems.length > MAX_PROBLEMS) shown.push(`and ${problems.length - MAX_PROBLEMS} more`);
    throw new Error(`${file}: ${problems.length} problem(s)\n- ${shown.join("\n- ")}`);
  }
  if (byId.size === 0) throw new Error(`${file}: no answers (expected one JSON object per line)`);
  return byId;
}

/**
 * A target that answers each case from a file of recorded answers, with no network call. A case with no line fails
 * with `no-answer`. With `repeat`, a case uses its lines in order, one per attempt; an attempt past the last line
 * fails with `no-answer` too, since reusing a line would count one answer as several samples.
 *
 * `path` is relative to where noxeval runs; pass `new URL("./answers.jsonl", import.meta.url)` in a config to make it
 * relative to the config file.
 */
export function jsonlTarget(path: string | URL, options: JsonlTargetOptions = {}): Target {
  const file = path instanceof URL ? fileURLToPath(path) : path;
  const shown = basename(file);
  const idField = options.idField ?? "id";
  let answers: Map<string, TargetResponse[]> | null = null;
  const used = new Map<string, number>();

  async function load(): Promise<Map<string, TargetResponse[]>> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      throw new Error(`${file}: ${err instanceof Error ? err.message : "cannot read"}`, { cause: err });
    }
    return parseJsonl(text, shown, idField);
  }

  return {
    name: options.name ?? shown,
    async prepare(suite: EvalCase[]) {
      // Read fresh on every run: the file is regenerated between runs, and attempts start again from the first line.
      answers = await load();
      used.clear();
      const ids = new Set(suite.map((c) => c.id));
      const unmatched = [...answers.keys()].filter((id) => !ids.has(id));
      if (!unmatched.length) return [];
      const list = unmatched.length > 8 ? `${unmatched.slice(0, 8).join(", ")}, ...` : unmatched.join(", ");
      return [`${unmatched.length} id(s) in ${shown} match no case: ${list}`];
    },
    async ask(c) {
      answers ??= await load();
      const lines = answers.get(c.id);
      if (!lines) throw new NoAnswerError(`no line for "${c.id}" in ${shown}`);
      const n = used.get(c.id) ?? 0;
      used.set(c.id, n + 1);
      const line = lines[n];
      if (!line) throw new NoAnswerError(`${shown} has ${lines.length} line(s) for "${c.id}"; attempt ${n + 1} has none`);
      return line;
    },
  };
}
