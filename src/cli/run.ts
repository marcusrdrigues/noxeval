import { access, appendFile, writeFile } from "node:fs/promises";
import { CONFIG_NAMES, loadConfig, resolveInputs } from "../config.ts";
import { toMarkdown } from "../app/markdown.ts";
import { runEval } from "../app/run.ts";
import { describeFailure } from "../domain/checks.ts";

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

  console.log(`noxeval: ${cases.length} cases against ${config.target.name}${judge ? `, judge ${judge.name}` : ""}\n`);
  const report = await runEval({
    target: config.target,
    cases,
    checks: inputs.checks,
    judge,
    planted: only ? inputs.planted.filter((p) => only.has(p.caseId)) : inputs.planted,
    concurrency: config.concurrency,
    onCase: (r) => {
      const judged = r.judge ? ` judge:${r.judge.pass ? "pass" : "FAIL"}` : r.judgeError ? " judge:error" : "";
      const why = r.passed ? "" : `  ${r.failures.map(describeFailure).join("; ")}`;
      console.log(`${r.passed ? "ok  " : "FAIL"}  ${r.id}${r.ms !== null ? ` ${r.ms}ms` : ""}${judged}${why}`);
    },
  });

  const out = args.out ?? config.report ?? "noxeval-report.json";
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  const md = toMarkdown(report);
  if (args.markdown) await writeFile(args.markdown, md + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");

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
  return report.passed === report.total ? 0 : 1;
}
