import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { buildReview, grade, summarizeReview, type ReviewFile } from "../domain/review.ts";
import type { HumanCheck, Report } from "../domain/report.ts";

export type ReviewArgs = { report?: string; file?: string; reset: boolean; summaryOnly: boolean };

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
};
const save = (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);

function print(s: HumanCheck): void {
  console.log(`\nGraded: ${s.reviewed} of ${s.total}`);
  const j = s.judgeAgreement;
  console.log(`Judge vs you:   ${j.agree}/${j.n} (${pct(j.agreement)}), kappa ${j.kappa ?? "n/a"}`);
  console.log(`  judge passed, you failed: ${j.matrix.raterPassHumanFail} · judge failed, you passed: ${j.matrix.raterFailHumanPass}`);
  const c = s.checkerAgreement;
  console.log(`Checker vs you: ${c.agree}/${c.n} (${pct(c.agreement)}), kappa ${c.kappa ?? "n/a"}`);
  if (s.planted.total)
    console.log(`Planted errors: judge caught ${s.planted.judgeCaught}/${s.planted.total}, you caught ${s.planted.humanCaught}`);
  if (s.disagreements.length) console.log(`Disagreements: ${s.disagreements.map((d) => d.key).join(", ")}`);
}

/**
 * Blind review in the terminal: one answer at a time, no verdicts shown. Saves after every grade, so `q` and a later
 * run pick up where you stopped. Reads answers line by line, so it also works with answers piped from a file.
 */
export async function reviewCommand(args: ReviewArgs): Promise<number> {
  const reportPath = args.report ?? "noxeval-report.json";
  const filePath = args.file ?? "noxeval-review.json";
  const report = await readJson<Report>(reportPath);
  if (!report) throw new Error(`cannot read ${reportPath}. Run first: npx noxeval run`);
  if (!report.judge) console.warn("note: this run has no judge; the review measures only the deterministic checks.");

  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | null> => {
    stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : String(value);
  };

  try {
    const fresh = buildReview(report, new Date().toISOString());
    let review = await readJson<ReviewFile>(filePath);
    if (args.summaryOnly) {
      const s = review && summarizeReview(review);
      if (s) print(s);
      else console.log("nothing graded yet");
      return 0;
    }
    if (review && review.runAt !== report.runAt && !args.reset) {
      const answer = (
        (await ask(`The saved review is for the run of ${review.runAt}. Start one for ${report.runAt} and replace it? [y/n] `)) ?? ""
      )
        .trim()
        .toLowerCase();
      if (answer !== "y") return 0;
    }
    if (!review || review.runAt !== report.runAt || args.reset) review = fresh.review;

    const pending = review.items.filter((i) => i.human === null);
    if (pending.length) {
      console.log(`Blind review: ${pending.length} answers left (of ${review.items.length}). y = correct, n = wrong, s = skip, q = quit.`);
      console.log("Correct = what the case expects: right facts, refuses when it should, leaks nothing.\n");
    }
    let index = review.items.length - pending.length;
    for (const item of pending) {
      index++;
      console.log(`\n── ${index}/${review.items.length} ${"─".repeat(30)}`);
      console.log(`Question${item.locale ? ` (${item.locale})` : ""}: ${item.question}`);
      if (item.expect) console.log(`Expected: ${item.expect}`);
      console.log(`Answer:   ${item.answer}`);
      let a = "";
      while (!["y", "n", "s", "q"].includes(a)) a = ((await ask("Correct? [y/n/s/q] ")) ?? "q").trim().toLowerCase();
      if (a === "q") break;
      if (a === "s") continue;
      const note = a === "n" ? ((await ask("What's wrong? (optional, Enter to skip) ")) ?? "") : "";
      grade(review, item.key, a === "y", note, fresh.hidden, new Date().toISOString());
      await save(filePath, review);
    }
    await save(filePath, review);
    const summary = summarizeReview(review);
    if (!summary) {
      console.log("\nnothing graded yet");
      return 0;
    }
    report.human = summary;
    await save(reportPath, report);
    print(summary);
    console.log(`\nSaved to ${filePath} and to the report (${reportPath}).`);
    return 0;
  } finally {
    rl.close();
  }
}
