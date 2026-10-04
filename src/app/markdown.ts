import { describeFailure } from "../domain/checks.ts";
import { formatCall } from "../domain/trajectory.ts";
import type { Report } from "../domain/report.ts";

const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** A short Markdown summary of a report: fits a pull request comment or a GitHub Actions job summary. */
export function toMarkdown(r: Report): string {
  const lines: string[] = [];
  const ok = r.passed === r.total;
  lines.push(`## noxeval: ${r.passed}/${r.total} passed ${ok ? "✅" : "❌"}`, "");
  lines.push(`Target \`${cell(r.target)}\` · ${r.runAt} · latency p50 ${r.latencyMs.p50 ?? "-"} ms, p90 ${r.latencyMs.p90 ?? "-"} ms`, "");

  const categories = Object.entries(r.categories);
  if (categories.length > 1) {
    lines.push("| Category | Passed |", "| --- | --- |");
    for (const [name, t] of categories) lines.push(`| ${cell(name)} | ${t.passed}/${t.total} |`);
    lines.push("");
  }

  if (r.repeat && r.repeat > 1) lines.push(`Each case asked ${r.repeat} times. Safety failures fail a case in any attempt.`, "");

  const failed = r.cases.filter((c) => !c.passed);
  if (failed.length) {
    lines.push("### Failed", "", "| Case | Why |", "| --- | --- |");
    for (const c of failed) lines.push(`| \`${cell(c.id)}\` | ${cell(c.failures.map(describeFailure).join("; "))} |`);
    lines.push("");
  }

  if (r.flaky?.length) {
    lines.push("### Flaky cases", "", "| Case | Passed | Lower bound (95%) | Failures seen |", "| --- | --- | --- | --- |");
    for (const id of r.flaky) {
      const c = r.cases.find((x) => x.id === id);
      if (!c?.attempts) continue;
      const ok = c.attempts.filter((a) => a.passed).length;
      lines.push(
        `| \`${cell(id)}\` | ${ok}/${c.attempts.length} | ${pct(c.passRateLow ?? null)} | ${cell(c.failures.map(describeFailure).join("; "))} |`,
      );
    }
    lines.push("");
  }

  if (r.tools) {
    const calls = Object.entries(r.tools.calls).sort((a, b) => b[1] - a[1]);
    lines.push(`### Tools: ${r.tools.cases} of ${r.total} cases called a tool`, "");
    if (calls.length) lines.push(calls.map(([name, n]) => `\`${cell(name)}\` ${n}`).join(" · "), "");
    const traced = r.cases.filter((c) => c.toolCalls?.length);
    if (traced.length) {
      lines.push("| Case | Calls |", "| --- | --- |");
      for (const c of traced) lines.push(`| \`${cell(c.id)}\` | ${cell((c.toolCalls ?? []).map(formatCall).join(" → "))} |`);
      lines.push("");
    }
  }

  if (r.judge) {
    lines.push(`### Judge: ${cell(r.judge.name)}`, "");
    lines.push(`Agreed with the deterministic checks on ${pct(r.judge.agreementWithChecker)} of ${r.judge.evaluated} cases.`);
    if (r.judge.disagreements.length)
      lines.push(`Disagreements (read these answers): ${r.judge.disagreements.map((id) => `\`${cell(id)}\``).join(", ")}.`);
    if (r.judge.lowConfidence.length) lines.push(`Low confidence: ${r.judge.lowConfidence.map((id) => `\`${cell(id)}\``).join(", ")}.`);
    lines.push("");
  }

  if (r.planted) {
    const d = r.planted.byDifficulty;
    lines.push(`### Planted errors: judge caught ${r.planted.caught}/${r.planted.total}`, "");
    lines.push(`Obvious ${d.obvious.caught}/${d.obvious.total} · subtle ${d.subtle.caught}/${d.subtle.total}.`);
    if (r.planted.missed.length) lines.push(`Missed: ${r.planted.missed.map((id) => `\`${cell(id)}\``).join(", ")}.`);
    lines.push("");
  }

  if (r.human) {
    const h = r.human;
    lines.push(`### Blind human review (${h.reviewed}/${h.total} graded)`, "");
    lines.push(
      `Judge vs human: ${h.judgeAgreement.agree}/${h.judgeAgreement.n} (${pct(h.judgeAgreement.agreement)}), kappa ${h.judgeAgreement.kappa ?? "n/a"}.`,
    );
    lines.push(
      `Checker vs human: ${h.checkerAgreement.agree}/${h.checkerAgreement.n} (${pct(h.checkerAgreement.agreement)}), kappa ${h.checkerAgreement.kappa ?? "n/a"}.`,
    );
    lines.push("");
  }
  return lines.join("\n");
}
