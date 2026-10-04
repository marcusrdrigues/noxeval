/**
 * Eval cases and planted errors: the data a run is made of.
 * Parsing is strict and reports every problem at once, so a broken case file fails before any API call.
 */

export type Turn = { role: "user" | "assistant"; content: string };

/** A scalar argument value a trajectory check compares (as a trimmed, case-insensitive string). */
export type Scalar = string | number | boolean;

/** One tool call the app made while answering, as the target reports it. */
export type ToolCall = { name: string; args?: Record<string, unknown> };

export type EvalCase = {
  /** Unique, stable id. Reports, planted errors and reviews refer to cases by id. */
  id: string;
  question: string;
  /** Language the answer must be in. "pt" and "en" are checked; any other value skips the language check. */
  locale?: string;
  /** Free grouping for the report (e.g. "fact", "injection", "off-topic"). */
  category?: string;
  /** What a correct answer looks like, in plain words. Shown to the human reviewer. */
  expect?: string;
  /** Every group must match at least one of its terms (accent- and case-insensitive). */
  mustInclude?: string[][];
  /** None of these terms may appear. */
  mustNotInclude?: string[];
  /** None of these regular expressions (case-insensitive) may match. */
  mustNotMatch?: string[];
  /** The app must refuse (matched against the refusal patterns of the case locale). */
  refusal?: boolean;
  /** Earlier turns sent with the question, for multi-turn attacks. */
  history?: Turn[];
  /** Free labels, e.g. OWASP risk ids ("LLM01"). Counted in the report. */
  tags?: string[];

  // Trajectory checks (0.3): what the app did to answer, not only what it said. The target reports `toolCalls`.
  /** At least one of these tools was called. Use only when the context alone can't answer (lists, whole documents). */
  mustCallTool?: string[];
  /** No tool was called at all. */
  mustNotCallTools?: boolean;
  /** None of these tools was called (e.g. `send_email` on an injection case). A safety failure. */
  forbiddenTools?: string[];
  /** Some call has all these arguments. */
  toolArgs?: Record<string, Scalar>;
  /** Every call to the named tool has these arguments; not calling it at all is fine. */
  toolArgsWhenCalled?: Record<string, Record<string, Scalar>>;
  /** At most this many tool calls. A safety failure (runaway loops cost money). */
  maxToolCalls?: number;
};

export type CaseFile = {
  /** Phrases that identify a refusal, per locale (e.g. { en: ["I only answer"] }). */
  refusalPatterns: Record<string, string[]>;
  cases: EvalCase[];
};

export type Difficulty = "obvious" | "subtle";

/** A wrong answer written on purpose, tied to a real case, to measure whether the judge fails what is wrong. */
export type PlantedError = {
  id: string;
  caseId: string;
  answer: string;
  /** What is wrong with it, for the report. Never shown to the human reviewer. */
  flaw?: string;
  /** "obvious" (made-up employer) or "subtle" (one swapped detail in an almost-right answer). Default "obvious". */
  difficulty?: Difficulty;
};

export class CaseFileError extends Error {
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file}: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
    this.name = "CaseFileError";
    this.problems = problems;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const isScalar = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const isScalarMap = (v: unknown): v is Record<string, Scalar> =>
  isObject(v) && Object.keys(v).length > 0 && Object.values(v).every(isScalar);

/** Problems in the trajectory fields of one case (0.3). */
function trajectoryProblems(c: Record<string, unknown>, at: string): string[] {
  const out: string[] = [];
  for (const key of ["mustCallTool", "forbiddenTools"] as const)
    if (c[key] !== undefined && !(isStringArray(c[key]) && c[key].length > 0))
      out.push(`${at}: "${key}" must be a non-empty array of tool names`);
  if (c.mustNotCallTools !== undefined && typeof c.mustNotCallTools !== "boolean")
    out.push(`${at}: "mustNotCallTools" must be true or false`);
  if (c.mustNotCallTools === true && (c.mustCallTool !== undefined || c.toolArgs !== undefined))
    out.push(`${at}: "mustNotCallTools" contradicts "mustCallTool" and "toolArgs"`);
  if (c.toolArgs !== undefined && !isScalarMap(c.toolArgs))
    out.push(`${at}: "toolArgs" must be an object of { argument: string | number | boolean }`);
  if (
    c.toolArgsWhenCalled !== undefined &&
    !(
      isObject(c.toolArgsWhenCalled) &&
      Object.keys(c.toolArgsWhenCalled).length > 0 &&
      Object.values(c.toolArgsWhenCalled).every(isScalarMap)
    )
  )
    out.push(`${at}: "toolArgsWhenCalled" must be an object of { tool: { argument: string | number | boolean } }`);
  if (c.maxToolCalls !== undefined && !(Number.isInteger(c.maxToolCalls) && (c.maxToolCalls as number) >= 0))
    out.push(`${at}: "maxToolCalls" must be a whole number, 0 or more`);
  return out;
}

/** True when the case checks the trajectory, so the target must report its tool calls. */
export function hasTrajectoryChecks(c: EvalCase): boolean {
  return (
    c.mustCallTool !== undefined ||
    c.mustNotCallTools !== undefined ||
    c.forbiddenTools !== undefined ||
    c.toolArgs !== undefined ||
    c.toolArgsWhenCalled !== undefined ||
    c.maxToolCalls !== undefined
  );
}

/** Validates a case file (already parsed from JSON). Throws CaseFileError listing every problem. */
export function parseCaseFile(raw: unknown, file = "cases"): CaseFile {
  const problems: string[] = [];
  const list = isObject(raw) ? raw.cases : raw;
  if (!Array.isArray(list)) throw new CaseFileError(file, ['expected an array of cases or an object with a "cases" array']);

  const refusalPatterns: Record<string, string[]> = {};
  if (isObject(raw) && raw.refusalPatterns !== undefined) {
    if (!isObject(raw.refusalPatterns)) problems.push("refusalPatterns must be an object of { locale: string[] }");
    else
      for (const [locale, patterns] of Object.entries(raw.refusalPatterns)) {
        if (isStringArray(patterns)) refusalPatterns[locale] = patterns;
        else problems.push(`refusalPatterns.${locale} must be an array of strings`);
      }
  }

  const seen = new Set<string>();
  const cases: EvalCase[] = [];
  list.forEach((c, i) => {
    const at = isObject(c) && typeof c.id === "string" ? `case "${c.id}"` : `case #${i + 1}`;
    if (!isObject(c)) return problems.push(`${at}: must be an object`);
    if (typeof c.id !== "string" || !c.id.trim()) problems.push(`${at}: "id" is required`);
    else if (seen.has(c.id)) problems.push(`${at}: duplicate id`);
    else seen.add(c.id);
    if (typeof c.question !== "string" || !c.question.trim()) problems.push(`${at}: "question" is required`);
    for (const key of ["locale", "category", "expect"] as const)
      if (c[key] !== undefined && typeof c[key] !== "string") problems.push(`${at}: "${key}" must be a string`);
    if (c.mustInclude !== undefined && !(Array.isArray(c.mustInclude) && c.mustInclude.every(isStringArray)))
      problems.push(`${at}: "mustInclude" must be an array of string arrays, e.g. [["Java", "Kotlin"]]`);
    for (const key of ["mustNotInclude", "mustNotMatch", "tags"] as const)
      if (c[key] !== undefined && !isStringArray(c[key])) problems.push(`${at}: "${key}" must be an array of strings`);
    if (isStringArray(c.mustNotMatch))
      for (const p of c.mustNotMatch)
        try {
          new RegExp(p, "i");
        } catch {
          problems.push(`${at}: invalid regular expression in "mustNotMatch": ${p}`);
        }
    if (c.refusal !== undefined && typeof c.refusal !== "boolean") problems.push(`${at}: "refusal" must be true or false`);
    if (c.refusal && typeof c.locale === "string" && isObject(raw) && !refusalPatterns[c.locale]?.length)
      problems.push(`${at}: "refusal" needs refusalPatterns for locale "${c.locale}"`);
    if (
      c.history !== undefined &&
      !(
        Array.isArray(c.history) &&
        c.history.every((t) => isObject(t) && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      )
    )
      problems.push(`${at}: "history" must be an array of { role: "user" | "assistant", content: string }`);
    problems.push(...trajectoryProblems(c, at));
    cases.push(c as EvalCase);
  });
  if (cases.length === 0) problems.push("no cases");
  if (problems.length) throw new CaseFileError(file, problems);
  return { refusalPatterns, cases };
}

/** Validates a planted-error file against the cases it refers to. */
export function parsePlantedFile(raw: unknown, caseIds: Set<string>, file = "planted"): PlantedError[] {
  const list = isObject(raw) ? raw.items : raw;
  if (!Array.isArray(list)) throw new CaseFileError(file, ['expected an array of planted errors or an object with an "items" array']);
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((p, i) => {
    const at = isObject(p) && typeof p.id === "string" ? `planted "${p.id}"` : `planted #${i + 1}`;
    if (!isObject(p)) return problems.push(`${at}: must be an object`);
    if (typeof p.id !== "string" || !p.id.trim()) problems.push(`${at}: "id" is required`);
    else if (seen.has(p.id)) problems.push(`${at}: duplicate id`);
    else seen.add(p.id);
    if (typeof p.caseId !== "string" || !caseIds.has(p.caseId)) problems.push(`${at}: "caseId" must be the id of an existing case`);
    if (typeof p.answer !== "string" || !p.answer.trim()) problems.push(`${at}: "answer" is required`);
    if (p.flaw !== undefined && typeof p.flaw !== "string") problems.push(`${at}: "flaw" must be a string`);
    if (p.difficulty !== undefined && p.difficulty !== "obvious" && p.difficulty !== "subtle")
      problems.push(`${at}: "difficulty" must be "obvious" or "subtle"`);
  });
  if (problems.length) throw new CaseFileError(file, problems);
  return list as PlantedError[];
}
