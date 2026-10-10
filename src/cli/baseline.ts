import { access, readFile, writeFile } from "node:fs/promises";
import { CONFIG_NAMES, loadConfig, type NoxevalConfig } from "../config.ts";
import { compareReports, parseBaseline, type Baseline, type Comparison } from "../domain/baseline.ts";
import type { Report } from "../domain/report.ts";

export const DEFAULT_BASELINE = "noxeval-baseline.json";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : "cannot read"}`, { cause: err });
  }
}

/** The baseline at a path, or null when the file doesn't exist yet. A file that exists but is broken is an error. */
export async function readBaseline(path: string): Promise<Baseline | null> {
  if (!(await exists(path))) return null;
  return parseBaseline(await readJson(path), path);
}

/** "baseline noxeval-baseline.json not found: ..." when a run names a baseline that doesn't exist yet. */
export const missingBaseline = (path: string) =>
  `baseline ${path} not found: every case must pass. Accept a run as the baseline with: npx noxeval baseline update`;

const list = (ids: string[], max = 8) => (ids.length > max ? `${ids.slice(0, max).join(", ")}, ...` : ids.join(", "));

/** The comparison for the terminal: one line of counts, then what to read and what to do. */
export function comparisonLines(c: Comparison): string[] {
  const lines = [
    `baseline: ${c.regressed.length} regressed · ${c.fixed.length} fixed · ${c.knownFailures.length} known failures · ` +
      `${c.new.length} new · ${c.removed.length} removed · ${c.unchanged} unchanged`,
  ];
  for (const r of c.regressed) lines.push(`  regressed ${r.id}: ${r.reason}`);
  if (c.knownFailures.length) lines.push(`  known failures (accepted, still failing): ${list(c.knownFailures)}`);
  if (c.removed.length) lines.push(`  removed: ${list(c.removed)}`);
  // A fixed case stays unguarded until it is accepted: if it breaks again, the baseline still says "fails".
  if (c.fixed.length)
    lines.push(`  ${c.fixed.length} fixed (${list(c.fixed)}): accept them with npx noxeval baseline update so they are guarded`);
  for (const w of c.warnings) lines.push(`  note: ${w}`);
  return lines;
}

/** What accepting a report changes in the baseline, so the reviewed change says it in words. */
export function updateLines(previous: Baseline | null, report: Report): string[] {
  const failing = report.cases.filter((c) => !c.passed).map((c) => c.id);
  if (!previous)
    return [
      `first baseline: ${report.total} cases, ${report.passed} passing` +
        (failing.length ? `; accepting ${failing.length} known failure(s): ${list(failing)}` : ""),
    ];
  const c = compareReports(previous, report);
  const lines: string[] = [];
  if (c.regressed.length) lines.push(`accepting as known failures: ${list(c.regressed.map((r) => r.id))}`);
  if (c.fixed.length) lines.push(`now guarded (fixed): ${list(c.fixed)}`);
  const added = c.new.filter((n) => n.passed).map((n) => n.id);
  if (added.length) lines.push(`added: ${list(added)}`);
  if (c.removed.length) lines.push(`removed: ${list(c.removed)}`);
  if (!lines.length) lines.push("no verdict changed");
  for (const w of c.warnings) lines.push(`note: ${w}`);
  return lines;
}

export type BaselineArgs = { config?: string; from?: string; baseline?: string };

/** The config, when there is one: it only supplies the default paths here. */
async function optionalConfig(explicit?: string): Promise<NoxevalConfig | null> {
  if (explicit) return (await loadConfig(explicit)).config;
  for (const name of CONFIG_NAMES) if (await exists(name)) return (await loadConfig(name)).config;
  return null;
}

/**
 * `noxeval baseline update`: accepts a report as the new baseline. The only way the baseline file changes: a run
 * never writes it, so accepting a regression is always a visible, reviewed change.
 */
export async function baselineUpdateCommand(args: BaselineArgs): Promise<number> {
  const config = await optionalConfig(args.config);
  const from = args.from ?? config?.report ?? "noxeval-report.json";
  const to = args.baseline ?? config?.baseline ?? DEFAULT_BASELINE;
  if (!(await exists(from))) throw new Error(`${from} not found: run npx noxeval run first, or pass --from <report>`);
  const raw = await readJson(from);
  if (typeof raw === "object" && raw !== null && (raw as { kind?: unknown }).kind === "noxeval-baseline")
    throw new Error(`${from} is a baseline, not a report: pass the report of the run to accept with --from`);
  // Validates the shape (and refuses a partial run) before anything is printed or written.
  const next = parseBaseline(raw, from);
  const report = raw as Report;
  const previous = await readBaseline(to);
  for (const line of updateLines(previous, report)) console.log(line);
  await writeFile(to, JSON.stringify(next, null, 2) + "\n");
  console.log(`wrote ${to}: ${next.total} cases, ${next.total - next.passed} known failure(s). Commit it with the change that caused it.`);
  return 0;
}
