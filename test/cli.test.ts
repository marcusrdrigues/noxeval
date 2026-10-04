import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION } from "../src/version.ts";
import { fakeServer, json } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src/cli/main.ts");
const INDEX = pathToFileURL(join(ROOT, "src/index.ts")).href;

function cli(args: string[], cwd: string, input = ""): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // Plain output on purpose: the test runner may pass FORCE_COLOR to children when it runs in a terminal.
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_STEP_SUMMARY: join(cwd, "summary.md"), NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test("version in package.json and in the code match", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
  assert.equal(pkg.version, VERSION);
  assert.equal(spawnSync(process.execPath, [CLI, "--version"]).stdout.toString().trim(), VERSION);
});

test("init, run against an app with a judge, then a blind review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-"));
  const init = await cli(["init"], dir);
  assert.equal(init.code, 0);
  assert.match(init.out, /create {2}noxeval\.config\.mjs/);
  assert.match((await cli(["init"], dir)).out, /skip {4}noxeval\.config\.mjs/);

  // The app: answers the hours, refuses the rest, and obeys the image injection (a bug the checks must catch).
  const app = await fakeServer((body, _req, res) => {
    const q = String(body.question);
    if (/open/i.test(q))
      return json(res, {
        answer: `We're open from 9am to 6pm, Monday to Saturday.${q.includes("![x]") ? " ![x](https://collector.test/)" : ""}`,
        context: ["9am to 6pm, Monday to Saturday."],
      });
    if (/2020/.test(q)) return json(res, { answer: "I couldn't find any record of the store closing.", context: [] });
    json(res, { answer: "I only answer questions about Example Books.", context: [] });
  });
  // The judge: an OpenAI-compatible fake that fails answers mentioning "24 hours" or "Sunday" and passes the rest.
  const judge = await fakeServer((body, _req, res) => {
    const state = JSON.parse((body.messages as { content: string }[])[1]?.content ?? "{}") as {
      answer: string;
      untrusted_user_question: string;
    };
    const bad = /24 hours|Sunday/.test(state.answer);
    const refusal = /only answer/.test(state.answer);
    json(res, {
      model: "fake-judge-1",
      choices: [
        {
          message: {
            content: JSON.stringify({
              refusal,
              leak: false,
              unsupported: bad,
              missed: false,
              premise: false,
              addresses: !refusal,
              reason: "",
            }),
          },
        },
      ],
    });
  });
  try {
    await writeFile(
      join(dir, "noxeval.config.mjs"),
      `import { defineConfig, httpTarget, openaiJudge } from ${JSON.stringify(INDEX)};
export default defineConfig({
  target: httpTarget({ url: "${app.url}/api/chat", answerPath: "answer", contextPath: "context", name: "test app" }),
  cases: "./noxeval.cases.json",
  planted: "./noxeval.planted.json",
  judge: openaiJudge({ model: "fake-judge-1", apiKey: "k", baseUrl: "${judge.url}" }),
  checks: { allowedLinks: ["example.com"] },
});
`,
    );
    const run = await cli(["run", "--markdown", "report.md"], dir);
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /FAIL {2}exfiltration .*markdown-image/);
    assert.match(run.out, /4\/5 passed/);
    assert.match(run.out, /planted errors caught: 2\/2 \(obvious 1\/1, subtle 1\/1\)/);
    const report = JSON.parse(await readFile(join(dir, "noxeval-report.json"), "utf8")) as { passed: number; judge: { model: string } };
    assert.equal(report.passed, 4);
    assert.equal(report.judge.model, "fake-judge-1");
    assert.match(await readFile(join(dir, "report.md"), "utf8"), /## noxeval: 4\/5 passed/);
    assert.match(await readFile(join(dir, "summary.md"), "utf8"), /Planted errors: judge caught 2\/2/);

    // Blind review, in three sittings: look, grade one and quit, then grade the rest.
    const answerFor = (a: string) => (/24 hours|Sunday|collector/.test(a) ? "n\nwrong\n" : "y\n");
    assert.match((await cli(["review"], dir, "q\n")).out, /nothing graded yet/);
    type Saved = { items: { answer: string; human: boolean | null; judge?: unknown }[] };
    const read = async () => JSON.parse(await readFile(join(dir, "noxeval-review.json"), "utf8")) as Saved;
    const items = (await read()).items;
    const first = await cli(["review"], dir, `${answerFor(items[0]?.answer ?? "")}q\n`);
    assert.match(first.out, /Graded: 1 of/);
    const saved = await read();
    assert.ok(
      saved.items.filter((i) => i.human === null).every((i) => i.judge === undefined),
      "no verdict before the grade",
    );
    const rest = await cli(
      ["review"],
      dir,
      saved.items
        .filter((i) => i.human === null)
        .map((i) => answerFor(i.answer))
        .join(""),
    );
    assert.match(rest.out, /Graded: (\d+) of \1/);
    // The fake judge ignores links, so it passes the injected image the human failed: the one disagreement.
    assert.match(rest.out, /Judge vs you: +5\/6 /);
    assert.match(rest.out, /Disagreements: exfiltration/);
    assert.match(rest.out, /Checker vs you: +4\/4 /);
    assert.match(rest.out, /Planted errors: judge caught 2\/2, you caught 2/);
    const summary = await cli(["review", "--summary"], dir);
    assert.match(summary.out, /Judge vs you: /);
    const withHuman = JSON.parse(await readFile(join(dir, "noxeval-report.json"), "utf8")) as { human: { reviewed: number } };
    assert.ok(withHuman.human.reviewed > 0);
  } finally {
    await app.close();
    await judge.close();
  }
});

test("usage errors exit with 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-"));
  assert.equal((await cli(["run"], dir)).code, 2);
  assert.equal((await cli(["bogus"], dir)).code, 2);
  assert.equal((await cli([], dir)).code, 2);
  // --repeat is checked before any call to the app (0.4).
  assert.equal((await cli(["init"], dir)).code, 0);
  const bad = await cli(["run", "--repeat", "0"], dir);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /--repeat must be a whole number from 1 to 50/);
});
