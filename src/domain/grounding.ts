/**
 * Ungrounded details (0.5): every checkable detail of an answer (a number, an acronym, a proper name) has to appear in
 * the context the model received. A pure rule, no model: cheap, explainable and tested. Ported from Nox, where it ran
 * for two weeks before anything else; the rules below are the ones that survived its runs.
 *
 * Number words and connectors cover Portuguese and English together, so no locale is needed.
 */

export type DetailKind = "number" | "acronym" | "name";

/** One detail of an answer: the text as written, its kind, the key used to compare, and its sentence. */
export type Detail = { kind: DetailKind; text: string; key: string; sentence: number };

export type DetailOptions = {
  /**
   * Names the answer may always say: the assistant's name, the person or company the app is about, its own channels.
   * They are never details, and they split neighboring names ("Python Marcus" is "Python", not one name).
   */
  allow?: readonly string[];
  /** Count a capitalized first word as a name. Used for questions, which often start with one. */
  firstWordCounts?: boolean;
};

/** Words that join the parts of a name ("Rio de Janeiro"). "e" and "and" are left out: they separate names. */
const CONNECTORS = new Set(["de", "da", "do", "das", "dos", "of", "the"]);

/** Negation marks: a detail from the question repeated in a denial ("I didn't find a prize in 2024"). */
const NEGATION = /(?:^|[^\p{L}])(?:não|nao|nenhum|nenhuma|nunca|sem|not|no|never|none)(?=$|[^\p{L}])|n['’]t(?=$|[^\p{L}])/iu;

/** Lowercase, without accents, only letters and digits separated by one space, padded for whole-word search. */
export function normalizeText(text: string): string {
  const flat = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${flat} `;
}

/** Sentences: split after ".", "!", "?" or ":" followed by a space, and at line breaks. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MULTIPLIER: Record<string, number> = {
  mil: 1e3,
  thousand: 1e3,
  k: 1e3,
  milhao: 1e6,
  milhoes: 1e6,
  million: 1e6,
  millions: 1e6,
  mi: 1e6,
};

/**
 * Canonical value of a written number: "10 mil", "10.000" and "10,000" become "10000"; "0,61" and "0.61" become "0.61".
 * A separator followed by exactly three digits is a thousands separator; any other is decimal.
 */
export function canonicalNumber(raw: string): string | null {
  const m = /^(\d+(?:[.,]\d+)*)\s*([a-zçõ]+)?$/i.exec(raw.normalize("NFD").replace(/[̀-ͯ]/g, "").trim());
  if (!m) return null;
  const digits = m[1] ?? "";
  const word = m[2];
  const value = /^\d{1,3}(?:[.,]\d{3})+$/.test(digits) ? Number(digits.replace(/[.,]/g, "")) : Number(digits.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const mult = word ? MULTIPLIER[word.toLowerCase()] : 1;
  if (word && mult === undefined) return String(value);
  return String(Math.round(value * (mult ?? 1) * 1000) / 1000);
}

/**
 * Loose numbers in a text, with their multiplier word ("10 mil"). A number glued to a letter, hyphen or dot is part of
 * an identifier ("BM25", "text-embedding-3-small", "v1.2") and doesn't count; after a slash it does ("mar/2023").
 */
function numbersIn(text: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  const re =
    /(?<![\p{L}\p{N}\-._])\d+(?:[.,]\d+)*(?:\s?(?:mil|thousand|milhões|milhoes|million|millions|mi|k)(?![\p{L}]))?(?![\p{L}\p{N}\-_]|[.,]\d)/gu;
  for (const m of text.matchAll(re)) out.push({ text: m[0], index: m.index ?? 0 });
  return out;
}

/** Numbers written as words in the context ("cinco trechos", "ten thousand inspections"). */
const WORD_NUMBERS: Record<string, number> = {
  um: 1,
  uma: 1,
  one: 1,
  dois: 2,
  duas: 2,
  two: 2,
  tres: 3,
  three: 3,
  quatro: 4,
  four: 4,
  cinco: 5,
  five: 5,
  seis: 6,
  six: 6,
  sete: 7,
  seven: 7,
  oito: 8,
  eight: 8,
  nove: 9,
  nine: 9,
  dez: 10,
  ten: 10,
  onze: 11,
  eleven: 11,
  doze: 12,
  twelve: 12,
  vinte: 20,
  twenty: 20,
  cem: 100,
  hundred: 100,
};

/** Canonical values of the numbers in a text, words included. */
export function numberSet(text: string): Set<string> {
  const set = new Set<string>();
  for (const n of numbersIn(text)) {
    const c = canonicalNumber(n.text);
    if (c) set.add(c);
  }
  const words = normalizeText(text).trim().split(" ");
  for (let i = 0; i < words.length; i++) {
    const v = WORD_NUMBERS[words[i] ?? ""];
    if (v === undefined) continue;
    set.add(String(v));
    const next = words[i + 1];
    if (next === "mil" || next === "thousand") set.add(String(v * 1000));
  }
  return set;
}

/** At least two capitals, or a capital with a digit, or a leading dot (".NET"). */
const isAcronym = (token: string) =>
  /^\./.test(token) || (token.match(/\p{Lu}/gu) ?? []).length >= 2 || (/^\p{Lu}/u.test(token) && /\d/.test(token));
const isCapitalized = (token: string) => /^\p{Lu}/u.test(token);

/** Punctuation around a word that isn't part of it. */
const EDGE = new Set([..."\"“”'‘’()[]{},;:!?…"]);
/** A full stop also leaves the end, but not the start (".NET"). */
const isEdge = (ch: string | undefined, atEnd: boolean) => ch !== undefined && (EDGE.has(ch) || (atEnd && ch === "."));

/** Words of a sentence with their position, without edge punctuation (a plain loop, no backtracking regex). */
function tokensOf(sentence: string): { text: string; index: number; quoted: boolean }[] {
  const out: { text: string; index: number; quoted: boolean }[] = [];
  let pos = 0;
  for (const raw of sentence.split(/\s/)) {
    let start = 0;
    let end = raw.length;
    while (start < end && isEdge(raw[start], false)) start++;
    while (end > start && isEdge(raw[end - 1], true)) end--;
    if (end > start) out.push({ text: raw.slice(start, end), index: pos + start, quoted: /["“'‘(]/.test(raw.slice(0, start)) });
    pos += raw.length + 1;
  }
  return out;
}

/** The allow list as normalized keys: each entry, and each of its words. */
function allowKeys(allow: readonly string[] = []): Set<string> {
  const keys = new Set<string>();
  for (const a of allow) {
    const key = normalizeText(a).trim();
    if (!key) continue;
    keys.add(key);
    for (const w of key.split(" ")) if (!CONNECTORS.has(w)) keys.add(w);
  }
  return keys;
}

/** The checkable details of a text, sentence by sentence. */
export function extractDetails(text: string, opts: DetailOptions = {}): Detail[] {
  const allowed = allowKeys(opts.allow);
  const details: Detail[] = [];
  splitSentences(text).forEach((sentence, si) => {
    for (const n of numbersIn(sentence)) {
      const key = canonicalNumber(n.text);
      if (key) details.push({ kind: "number", text: n.text, key, sentence: si });
    }
    let phrase: string[] = [];
    const flush = () => {
      // A trailing connector isn't part of the name ("Vibetex e" is "Vibetex").
      while (phrase.length && CONNECTORS.has((phrase[phrase.length - 1] ?? "").toLowerCase())) phrase.pop();
      if (phrase.length) {
        const name = phrase.join(" ");
        details.push({ kind: "name", text: name, key: normalizeText(name).trim(), sentence: si });
      }
      phrase = [];
    };
    tokensOf(sentence).forEach((tok, ti) => {
      const t = tok.text;
      if (/\d/.test(t) && !/\p{L}/u.test(t)) {
        flush();
        return;
      }
      // Right after a quote, a capital may only start the quotation.
      const startsSentence = (ti === 0 && !opts.firstWordCounts) || tok.quoted;
      if (isAcronym(t)) {
        flush();
        details.push({ kind: "acronym", text: t, key: normalizeText(t).trim(), sentence: si });
      } else if (allowed.has(normalizeText(t).trim())) {
        // An allowed name ends the previous one: "Python Marcus" are two names.
        flush();
      } else if (isCapitalized(t) && !startsSentence) {
        phrase.push(t);
      } else if (phrase.length && CONNECTORS.has(t.toLowerCase())) {
        phrase.push(t);
      } else {
        flush();
      }
    });
    flush();
  });
  return details.filter((d) => d.key && !allowed.has(d.key));
}

/** Context ready to check against: the normalized text and its set of numbers. */
export type ContextIndex = { text: string; numbers: Set<string> };

export function indexContext(context: readonly string[]): ContextIndex {
  const joined = context.join("\n");
  return { text: normalizeText(joined), numbers: numberSet(joined) };
}

/** Is the detail in the context? A number by value; an acronym or name as a whole word, plural "s" allowed. */
export function isGrounded(detail: Detail, index: ContextIndex): boolean {
  if (detail.kind === "number") return index.numbers.has(detail.key);
  const has = (key: string) => index.text.includes(` ${key} `);
  if (has(detail.key)) return true;
  if (detail.key.endsWith("s") && has(detail.key.slice(0, -1))) return true;
  // A composed name passes when each meaningful word is in the context ("Spring Boot" with "Boot" after a line break).
  if (detail.kind === "name" && detail.key.includes(" ")) {
    return detail.key
      .split(" ")
      .filter((w) => !CONNECTORS.has(w))
      .every((w) => has(w));
  }
  return false;
}

/** A plausible year ("2023"): what date arithmetic uses. */
const isYear = (key: string) => /^(?:19|20)\d{2}$/.test(key);

/** Years of the answer that are in the context: the base of date arithmetic. */
export function groundedYears(answer: string, context: readonly string[], opts: DetailOptions = {}): number[] {
  const index = indexContext(context);
  const years = extractDetails(answer, opts).filter((d) => d.kind === "number" && isYear(d.key) && isGrounded(d, index));
  return [...new Set(years.map((d) => Number(d.key)))];
}

/**
 * A number of years that is the difference between two grounded years of the answer ("joined in 2023. Moved to Vibetex
 * in 2026, 3 years later."): arithmetic in plain sight, not a new detail. Only for a number followed by "year(s)" or
 * "ano(s)"; without the two years in the answer, the number still needs a source.
 */
function isYearDifference(detail: Detail, sentence: string, years: readonly number[]): boolean {
  if (detail.kind !== "number" || isYear(detail.key)) return false;
  const n = Number(detail.key);
  if (!Number.isInteger(n) || n < 1 || n > 100) return false;
  const span = new RegExp(`(?<![\\p{N}.,])${detail.text.replace(/[.,]/g, "\\$&")}\\s+(?:anos?|years?)(?![\\p{L}])`, "iu");
  if (!span.test(sentence)) return false;
  return years.some((a, i) => years.some((b, k) => k > i && Math.abs(a - b) === n));
}

export type GroundingOptions = DetailOptions & {
  /** The question: a detail that came from it passes only in a sentence that negates it (the premise bait). */
  question?: string;
  /** Grounded years from elsewhere in the answer, when checking one sentence at a time. */
  contextYears?: readonly number[];
};

/**
 * Details of the answer that are in no context item. The difference between two grounded years is arithmetic, not a
 * detail. A detail that came from the question passes only in a sentence that negates it ("I didn't find a prize in
 * 2024"); repeated in a statement, it counts as ungrounded, because that is how the question's bait becomes a fact.
 */
export function ungroundedDetails(answer: string, context: readonly string[], opts: GroundingOptions = {}): Detail[] {
  const index = indexContext(context);
  const detailOpts: DetailOptions = opts.allow ? { allow: opts.allow } : {};
  // In the question, the first word counts as a name (a short question often starts with one).
  const fromQuestion = new Set(
    extractDetails(opts.question ?? "", { ...detailOpts, firstWordCounts: true }).map((d) => `${d.kind}:${d.key}`),
  );
  const sentences = splitSentences(answer);
  const details = extractDetails(answer, detailOpts);
  const years = [...new Set([...groundedYears(answer, context, detailOpts), ...(opts.contextYears ?? [])])];
  return details.filter((d) => {
    if (isGrounded(d, index)) return false;
    const sentence = sentences[d.sentence] ?? "";
    if (isYearDifference(d, sentence, years)) return false;
    if (fromQuestion.has(`${d.kind}:${d.key}`) && NEGATION.test(sentence)) return false;
    return true;
  });
}
