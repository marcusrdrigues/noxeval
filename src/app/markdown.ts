import { describeFailure } from "../domain/checks.ts";
import { formatCall } from "../domain/trajectory.ts";
import type { Report } from "../domain/report.ts";
import { signed, type Comparison } from "../domain/baseline.ts";
import { formatUsd } from "../domain/limits.ts";

const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "p50 840 ms · p90 1200 ms · p95 1500 ms", shared by the terminal and the Markdown summary. */
export const latencyText = (l: Report["latencyMs"]): string => `p50 ${l.p50 ?? "-"} ms · p90 ${l.p90 ?? "-"} ms · p95 ${l.p95 ?? "-"} ms`;

/** "total $0.0123 · mean $0.00041 · p90 $0.00090 per answer (2 answers without a cost)", or null without cost data. */
export function costText(r: Report): string | null {
  const c = r.cost;
  if (!c) return null;
  return (
    `total ${formatUsd(c.totalUsd)} · mean ${formatUsd(c.meanUsd)} · p90 ${formatUsd(c.p90Usd)} per answer` +
    (c.notReported ? ` (${c.notReported} answer${c.notReported > 1 ? "s" : ""} without a cost)` : "")
  );
}

/** Limits that couldn't be checked, or null when every limit was. Never silent: "not checked" is not "within". */
export function notCheckedText(r: Report): string | null {
  const n = r.notChecked;
  if (!n) return null;
  const parts = [
    ...(n.cost.length ? [`cost on ${n.cost.length} case(s), no costUsd reported: ${n.cost.join(", ")}`] : []),
    ...(n.latency.length ? [`latency on ${n.latency.length} case(s), not timed: ${n.latency.join(", ")}`] : []),
  ];
  return `limits not checked: ${parts.join("; ")}`;
}

/** "cost per answer: mean +12.5%, p90 +3% (total +40%) · latency p95 -4%", or null when nothing compares. */
export function changesText(c: Comparison): string | null {
  const ch = c.changes;
  const parts: string[] = [];
  if (ch.meanCostPct !== null || ch.p90CostPct !== null)
    parts.push(`cost per answer: mean ${signed(ch.meanCostPct)}, p90 ${signed(ch.p90CostPct)} (total ${signed(ch.totalCostPct)})`);
  if (ch.p95LatencyPct !== null) parts.push(`latency p95 ${signed(ch.p95LatencyPct)}`);
  return parts.length ? parts.join(" · ") : null;
}

const ids = (list: string[]) => (list.length ? list.map((id) => `\`${cell(id)}\``).join(", ") : "-");

/** "Compared with the baseline": counts first, then why each regressed case regressed. */
function comparisonTable(b: Comparison): string[] {
  const lines = [`### Compared with the baseline of ${b.baseline.runAt}`, "", "| | Cases |", "| --- | --- |"];
  lines.push(`| Regressed | ${ids(b.regressed.map((x) => x.id))} |`);
  lines.push(`| Fixed | ${ids(b.fixed)} |`);
  lines.push(`| Known failures | ${ids(b.knownFailures)} |`);
  lines.push(`| Flaky | ${ids(b.flaky)} |`);
  lines.push(`| New | ${ids(b.new.map((x) => x.id))} |`);
  lines.push(`| Removed | ${ids(b.removed)} |`);
  lines.push(`| Unchanged | ${b.unchanged} |`, "");
  const changes = changesText(b);
  if (changes) lines.push(`Against the baseline: ${cell(changes)}.`, "");
  if (b.regressed.length) {
    lines.push("| Regressed case | Why |", "| --- | --- |");
    for (const x of b.regressed) lines.push(`| \`${cell(x.id)}\` | ${cell(x.reason)} |`);
    lines.push("");
  }
  if (b.fixed.length)
    lines.push("Fixed cases are not guarded until accepted: run `npx noxeval baseline update` and commit the baseline.", "");
  for (const w of b.warnings) lines.push(`Note: ${cell(w)}.`, "");
  return lines;
}

/** A short Markdown summary of a report: fits a pull request comment or a GitHub Actions job summary. */
export function toMarkdown(r: Report): string {
  const lines: string[] = [];
  const b = r.baseline;
  if (b) {
    // With a baseline the headline is the gate: a known failure is not news, a regression is.
    const known = r.total - r.passed;
    const counts = `(${r.passed}/${r.total} passed${known ? `, ${known} known failure${known > 1 ? "s" : ""}` : ""})`;
    lines.push(b.passed ? `## noxeval: no regressions ✅ ${counts}` : `## noxeval: ${b.regressed.length} regressed ❌ ${counts}`, "");
  } else lines.push(`## noxeval: ${r.passed}/${r.total} passed ${r.passed === r.total ? "✅" : "❌"}`, "");
  lines.push(`Target \`${cell(r.target)}\` · ${r.runAt} · latency ${latencyText(r.latencyMs)}`, "");
  const cost = costText(r);
  if (cost) lines.push(`Cost: ${cost}.`, "");
  const unchecked = notCheckedText(r);
  if (unchecked) lines.push(`${cell(unchecked.replace(/^limits/, "Limits"))}.`, "");
  for (const n of r.notes ?? []) lines.push(`Note: ${cell(n)}.`, "");
  if (b) lines.push(...comparisonTable(b));

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

  if (r.grounding) {
    const g = r.grounding;
    lines.push(`### Ungrounded details: ${g.withUngrounded} of ${g.checked} answers (${g.mode})`, "");
    if (g.cases.length) {
      lines.push("| Case | Not in the context |", "| --- | --- |");
      for (const c of g.cases) lines.push(`| \`${cell(c.id)}\` | ${cell(c.details.join(", "))} |`);
      lines.push("");
    }
    if (g.notChecked) lines.push(`${g.notChecked} answers not checked: the target returned no context.`, "");
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
