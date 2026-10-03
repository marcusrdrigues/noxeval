import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCaseFile, parsePlantedFile, type CaseFile, type EvalCase, type PlantedError } from "./domain/case.ts";
import type { CheckOptions } from "./domain/checks.ts";
import type { Judge, Target } from "./ports.ts";

export type NoxevalConfig = {
  target: Target;
  /** Path to a case file (relative to the config), a case file object or a list of cases. */
  cases: string | CaseFile | EvalCase[];
  /** Path to a planted-error file or the list itself. Needs a judge. */
  planted?: string | PlantedError[];
  judge?: Judge | null;
  /** Refusal patterns here are merged over the ones in the case file. */
  checks?: CheckOptions;
  concurrency?: number;
  /** Where `noxeval run` writes the report. Default "noxeval-report.json". */
  report?: string;
};

/** Identity function that gives editors the config type in a plain .mjs file. */
export const defineConfig = (config: NoxevalConfig): NoxevalConfig => config;

export const CONFIG_NAMES = ["noxeval.config.mjs", "noxeval.config.js"];

export async function loadConfig(path: string): Promise<{ config: NoxevalConfig; dir: string }> {
  const full = resolve(path);
  const mod = (await import(pathToFileURL(full).href)) as { default?: NoxevalConfig };
  const config = mod.default;
  if (!config || typeof config !== "object" || !config.target || typeof config.target.ask !== "function")
    throw new Error(`${path}: export default defineConfig({ target, cases })`);
  return { config, dir: dirname(full) };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : "cannot read"}`, { cause: err });
  }
}

/** Loads and validates the cases and planted errors a config points to. */
export async function resolveInputs(
  config: NoxevalConfig,
  dir: string,
): Promise<{ cases: EvalCase[]; checks: CheckOptions; planted: PlantedError[] }> {
  const rawCases = typeof config.cases === "string" ? await readJson(resolve(dir, config.cases)) : config.cases;
  const file = parseCaseFile(rawCases, typeof config.cases === "string" ? config.cases : "cases");
  const checks: CheckOptions = { ...config.checks, refusalPatterns: { ...file.refusalPatterns, ...config.checks?.refusalPatterns } };
  let planted: PlantedError[] = [];
  if (config.planted) {
    const raw = typeof config.planted === "string" ? await readJson(resolve(dir, config.planted)) : config.planted;
    planted = parsePlantedFile(raw, new Set(file.cases.map((c) => c.id)), typeof config.planted === "string" ? config.planted : "planted");
  }
  return { cases: file.cases, checks, planted };
}
