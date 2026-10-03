import { access, appendFile, writeFile } from "node:fs/promises";
import { CONFIG_NAMES, loadConfig, resolveInputs } from "../config.ts";
import { toMarkdown } from "../app/markdown.ts";
import { runEval } from "../app/run.ts";
import { describeFailure } from "../domain/checks.ts";
import type { Report } from "../domain/report.ts";
import { VERSION } from "../version.ts";
import { colorEnabled, createUi, spinner, wrap, type Ui } from "./ui.ts";

export type RunArgs = { config?: string; out?: string; markdown?: string; only?: string; noJudge: boolean };

async function findConfig(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  for (const name of CONFIG_NAMES)
    if (
      await access(name).then(
        () => true,
        () => false,
      )
    )
      return name;
  throw new Error("no noxeval.config.mjs here. Create one with: npx noxeval init");
}

export async function runCommand(args: RunArgs): Promise<number> {
  const path = await findConfig(args.config);
  const { config, dir } = await loadConfig(path);
  const inputs = await resolveInputs(config, dir);
  const only = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
  const cases = only ? inputs.cases.filter((c) => only.has(c.id)) : inputs.cases;
  if (cases.length === 0) throw new Error(`no case matches --only ${args.only}`);
  const judge = args.noJudge ? null : (config.judge ?? null);

  const ui = createUi({ color: colorEnabled(process.env, Boolean(process.stdout.isTTY)), columns: process.stdout.columns });
  const live = spinner(ui, (t) => process.stdout.write(t));
  const plan = `${cases.length} cases against ${config.target.name}${judge ? `, judge ${judge.name}` : ""}`;
  if (ui.color) console.log(`${ui.banner(VERSION, "evaluate LLM apps you can trust")}\n  ${plan}\n`);
  else console.log(`noxeval: ${plan}\n`);

  let finished = 0;
  // The spinner's timer would keep the process alive after an error: always stop it.
  const report = await runEval({
    target: config.target,
    cases,
    checks: inputs.checks,
    judge,
    planted: only ? inputs.planted.filter((p) => only.has(p.caseId)) : inputs.planted,
    concurrency: config.concurrency,
    onStart: (c, inFlight) =>
      live.update(
        inFlight > 1 ? `${inFlight} running · ${finished}/${cases.length} done` : `asking ${c.id} · ${finished}/${cases.length} done`,
      ),
    onCase: (r) => {
      finished++;
      live.clear();
      if (ui.color) console.log(ui.caseLine({ ...r, failures: r.failures.map(describeFailure) }));
      else {
        const judged = r.judge ? ` judge:${r.judge.pass ? "pass" : "FAIL"}` : r.judgeError ? " judge:error" : "";
        const why = r.passed ? "" : `  ${r.failures.map(describeFailure).join("; ")}`;
        console.log(`${r.passed ? "ok  " : "FAIL"}  ${r.id}${r.ms !== null ? ` ${r.ms}ms` : ""}${judged}${why}`);
      }
      if (finished < cases.length) live.update(`${finished}/${cases.length} done`);
    },
    onPlanted: () => live.update("judging planted errors"),
  }).finally(() => live.clear());

  const out = args.out ?? config.report ?? "noxeval-report.json";
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  const md = toMarkdown(report);
  if (args.markdown) await writeFile(args.markdown, md + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");

  if (ui.color)
    console.log(
      `\n${summaryBox(ui, report)}\n  ${ui.c.dim(`report: ${out}${judge ? " · check the judge with: npx noxeval review" : ""}`)}\n`,
    );
  else {
    console.log(
      `\n${report.passed}/${report.total} passed · latency p50 ${report.latencyMs.p50 ?? "-"} ms, p90 ${report.latencyMs.p90 ?? "-"} ms`,
    );
    if (report.judge) {
      const j = report.judge;
      console.log(`judge agreed with the checks on ${Math.round((j.agreementWithChecker ?? 0) * 100)}% of ${j.evaluated} cases`);
      if (j.disagreements.length) console.log(`  disagreements (read these): ${j.disagreements.join(", ")}`);
      if (j.lowConfidence.length) console.log(`  low confidence: ${j.lowConfidence.join(", ")}`);
    }
    if (report.planted) {
      const p = report.planted;
      console.log(
        `planted errors caught: ${p.caught}/${p.total} (obvious ${p.byDifficulty.obvious.caught}/${p.byDifficulty.obvious.total}, subtle ${p.byDifficulty.subtle.caught}/${p.byDifficulty.subtle.total})`,
      );
      if (p.missed.length) console.log(`  missed: ${p.missed.join(", ")}`);
    }
    console.log(`report: ${out}${judge ? " · check the judge with: npx noxeval review" : ""}`);
  }
  return report.passed === report.total ? 0 : 1;
}

/** The end-of-run summary on a color terminal: score, judge, planted errors and latency in one box. */
function summaryBox(ui: Ui, r: Report): string {
  const lines = [ui.meter("cases", r.passed, r.total)];
  if (r.judge) {
    const agree = Math.round((r.judge.agreementWithChecker ?? 0) * r.judge.evaluated);
    lines.push(ui.meter("judge", agree, r.judge.evaluated, "agreed with the checks"));
  }
  if (r.planted) {
    const d = r.planted.byDifficulty;
    lines.push(
      ui.meter(
        "planted",
        r.planted.caught,
        r.planted.total,
        `obvious ${d.obvious.caught}/${d.obvious.total} · subtle ${d.subtle.caught}/${d.subtle.total}`,
      ),
    );
  }
  lines.push(`${ui.pad("latency", 9)} ${ui.c.dim(`p50 ${r.latencyMs.p50 ?? "-"} ms · p90 ${r.latencyMs.p90 ?? "-"} ms`)}`);
  const read = [...(r.judge?.disagreements ?? []), ...(r.planted?.missed ?? [])];
  if (read.length) lines.push("", ...wrap(`read these: ${read.join(", ")}`, ui.width - 4).map((l) => ui.c.gold(l)));
  return ui.box(lines, r.passed === r.total ? "all passed" : `${r.total - r.passed} failed`);
}
