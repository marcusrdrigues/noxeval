#!/usr/bin/env node
import { parseArgs } from "node:util";
import { VERSION } from "../version.ts";
import { initCommand } from "./init.ts";
import { runCommand } from "./run.ts";
import { reviewCommand } from "./review.ts";
import { baselineUpdateCommand } from "./baseline.ts";

const HELP = `noxeval ${VERSION}: evaluate LLM apps you can trust

Usage:
  noxeval init                      create a config, cases and planted errors
  noxeval run [options]             run the cases and write the report
  noxeval review [options]          grade the last run blind, to check the judge
  noxeval baseline update [options] accept a report as the baseline (never automatic)

run options:
  -c, --config <file>               default noxeval.config.mjs
  -o, --out <file>                  report path (default from config or noxeval-report.json)
      --markdown <file>             also write a Markdown summary
      --only <id,id>                run only these case ids
      --repeat <n>                  ask each case n times and report pass rates
      --grounding <mode>            off, report or check: numbers and names must be in the context
      --baseline <file>             compare with an accepted run: fail only on regressions
      --no-judge                    skip the judge and planted errors

review options:
  -r, --report <file>               default noxeval-report.json
  -f, --file <file>                 review file (default noxeval-review.json)
      --reset                       start this run's review over
      --summary                     only print the agreement numbers

baseline update options:
      --from <file>                 report to accept (default from config or noxeval-report.json)
      --baseline <file>             baseline to write (default from config or noxeval-baseline.json)

Exit codes: 0 all passed (with a baseline: nothing regressed) · 1 some case failed (with a baseline: something
regressed) · 2 usage or config error.
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      out: { type: "string", short: "o" },
      markdown: { type: "string" },
      only: { type: "string" },
      repeat: { type: "string" },
      grounding: { type: "string" },
      baseline: { type: "string" },
      from: { type: "string" },
      "no-judge": { type: "boolean" },
      report: { type: "string", short: "r" },
      file: { type: "string", short: "f" },
      reset: { type: "boolean" },
      summary: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 2;
  }
  switch (command) {
    case "init":
      return initCommand(process.cwd());
    case "run":
      return runCommand({
        config: values.config,
        out: values.out,
        markdown: values.markdown,
        only: values.only,
        repeat: values.repeat,
        grounding: values.grounding,
        baseline: values.baseline,
        noJudge: values["no-judge"] === true,
      });
    case "review":
      return reviewCommand({
        report: values.report,
        file: values.file,
        reset: values.reset === true,
        summaryOnly: values.summary === true,
      });
    case "baseline":
      if (positionals[1] !== "update") {
        console.error(`usage: noxeval baseline update [--from <report>] [--baseline <file>]\n\n${HELP}`);
        return 2;
      }
      return baselineUpdateCommand({ config: values.config, from: values.from, baseline: values.baseline });
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    console.error(`noxeval: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  },
);
