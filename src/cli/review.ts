import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { buildReview, grade, summarizeReview, type ReviewFile } from "../domain/review.ts";
import type { HumanCheck, Report } from "../domain/report.ts";
import { colorEnabled, createUi, type Ui } from "./ui.ts";
import { exists, isNoxevalReport, isReviewFile, targetPath } from "./paths.ts";
import { VERSION } from "../version.ts";

export type ReviewArgs = { report?: string; file?: string; reset: boolean; summaryOnly: boolean; allowOutside: boolean };

const cause = (err: unknown) => (err instanceof Error ? err.message : "cannot read");
const save = (path: string, data: unknown) => writeFile(path, JSON.stringify(data, null, 2) + "\n");
const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);

function printBox(ui: Ui, s: HumanCheck): void {
  const j = s.judgeAgreement;
  const k = s.checkerAgreement;
  const lines = [
    ui.meter("judge", j.agree, j.n, `kappa ${j.kappa ?? "n/a"}`),
    ui.meter("checks", k.agree, k.n, `kappa ${k.kappa ?? "n/a"}`),
  ];
  if (s.planted.total) lines.push(ui.meter("planted", s.planted.judgeCaught, s.planted.total, `you caught ${s.planted.humanCaught}`));
  lines.push(
    ui.c.dim(`judge passed, you failed: ${j.matrix.raterPassHumanFail} · judge failed, you passed: ${j.matrix.raterFailHumanPass}`),
  );
  if (s.disagreements.length) lines.push("", ui.c.gold(`disagreements: ${s.disagreements.map((d) => d.key).join(", ")}`));
  console.log(`\n${ui.box(lines, `graded ${s.reviewed} of ${s.total}`)}`);
}

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
  const reportArg = args.report ?? "noxeval-report.json";
  const fileArg = args.file ?? "noxeval-review.json";
  const reportPath = targetPath(reportArg, "--report", args.allowOutside);
  const filePath = targetPath(fileArg, "--file", args.allowOutside);
  // Read strictly: "not there" is the only path to the hint below. A report that exists but is broken says why, and a
  // file that is not noxeval's is named as such, instead of both quietly reading as if there were nothing.
  if (!(await exists(reportPath))) throw new Error(`cannot read ${reportArg}. Run first: npx noxeval run`);
  let rawReport: unknown;
  try {
    rawReport = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (err) {
    throw new Error(`${reportArg}: ${cause(err)}`, { cause: err });
  }
  if (!isNoxevalReport(rawReport)) throw new Error(`${reportArg} is not a noxeval report`);
  const report = rawReport as Report;
  if (!report.judge) console.warn("note: this run has no judge; the review measures only the deterministic checks.");

  const ui = createUi({ color: colorEnabled(process.env, Boolean(stdout.isTTY)), columns: stdout.columns });
  const show = (s: HumanCheck) => (ui.color ? printBox(ui, s) : print(s));
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | null> => {
    stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : String(value);
  };

  try {
    const fresh = buildReview(report, new Date().toISOString());
    let review: ReviewFile | null = null;
    if (await exists(filePath)) {
      let rawFile: unknown;
      try {
        rawFile = JSON.parse(await readFile(filePath, "utf8"));
      } catch (err) {
        // A fresh start here would silently throw away the grades and notes saved in the file: the person decides.
        throw new Error(`${fileArg}: ${cause(err)}. Delete the file to start over (saved grades are lost)`, { cause: err });
      }
      if (!isReviewFile(rawFile)) throw new Error(`${fileArg} is not a noxeval review file: move or delete it, or choose another --file`);
      review = rawFile as ReviewFile;
    }
    if (args.summaryOnly) {
      const s = review && summarizeReview(review);
      if (s) show(s);
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
      if (ui.color) console.log(ui.banner(VERSION, "blind review: no verdict is shown, grade with your own knowledge"));
      console.log(`Blind review: ${pending.length} answers left (of ${review.items.length}). y = correct, n = wrong, s = skip, q = quit.`);
      console.log("Correct = what the case expects: right facts, refuses when it should, leaks nothing.\n");
    }
    let index = review.items.length - pending.length;
    for (const item of pending) {
      index++;
      if (ui.color) {
        const progress = `${index}/${review.items.length}`;
        console.log(`\n${ui.c.purple(`── ${progress} ${"─".repeat(Math.max(0, ui.width - progress.length - 4))}`)}`);
        console.log(ui.card(`QUESTION${item.locale ? ` (${item.locale})` : ""}`, item.question));
        if (item.expect) console.log(ui.card("EXPECTED", item.expect));
        console.log(ui.card("ANSWER", item.answer));
      } else {
        console.log(`\n── ${index}/${review.items.length} ${"─".repeat(30)}`);
        console.log(`Question${item.locale ? ` (${item.locale})` : ""}: ${item.question}`);
        if (item.expect) console.log(`Expected: ${item.expect}`);
        console.log(`Answer:   ${item.answer}`);
      }
      const prompt = ui.color ? `${ui.c.purple("›")} correct? ${ui.c.dim("[y]es [n]o [s]kip [q]uit")} ` : "Correct? [y/n/s/q] ";
      let a = "";
      while (!["y", "n", "s", "q"].includes(a)) a = ((await ask(prompt)) ?? "q").trim().toLowerCase();
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
    show(summary);
    console.log(`\nSaved to ${fileArg} and to the report (${reportArg}).`);
    return 0;
  } finally {
    rl.close();
  }
}
