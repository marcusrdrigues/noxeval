import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { guardNoxevalFile, insideProject, isNoxevalReport, isNoxevalSummary, isReviewFile, targetPath } from "../src/cli/paths.ts";
import { buildReport, type CaseResult, type Report } from "../src/domain/report.ts";
import { fakeServer, json } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src/cli/main.ts");
const INDEX = pathToFileURL(join(ROOT, "src/index.ts")).href;

function cli(args: string[], cwd: string, input = ""): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    // Plain output on purpose: the test runner may pass FORCE_COLOR to children when it runs in a terminal.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
    child.stdin.end(input);
  });
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A project folder inside its own parent, so `../x` still lands in a noxeval-controlled temp folder. */
async function project(): Promise<{ dir: string; parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), "noxeval-paths-"));
  const dir = join(parent, "project");
  await mkdir(dir);
  return { dir, parent };
}

const res = (id: string): CaseResult => ({
  id,
  question: `question ${id}`,
  passed: true,
  failures: [],
  answer: `the answer of ${id}`,
  contextSize: 0,
  ms: 10,
});
const report = (cases: CaseResult[]): Report =>
  buildReport({ version: "0.6.0", runAt: "2026-11-18T12:00:00.000Z", target: "app", judgeName: null, cases, planted: [] });

const httpConfig = (url: string, reportPath?: string) => `import { defineConfig, httpTarget } from ${JSON.stringify(INDEX)};
export default defineConfig({
  target: httpTarget({ url: ${JSON.stringify(url)}, answerPath: "answer" }),
  cases: [{ id: "a", question: "When is the store open?", mustInclude: [["9"]] }],${reportPath ? `\n  report: ${JSON.stringify(reportPath)},` : ""}
});
`;

test("insideProject: inside after resolving is fine, outside is refused with the flag name", () => {
  const root = join(tmpdir(), "noxeval-unit");
  assert.equal(insideProject("report.json", "--out", root), resolve(root, "report.json"));
  assert.equal(insideProject(join("sub", "..", "report.json"), "--out", root), resolve(root, "report.json"));
  assert.throws(() => insideProject("../outside.json", "--out", root), /--out must be a file inside /);
  assert.throws(() => insideProject(join(tmpdir(), "elsewhere.json"), "--out", root), /--out must be a file inside /);
  assert.equal(targetPath("../outside.json", "--out", true, root), resolve(root, "..", "outside.json"));
  assert.throws(() => targetPath("../outside.json", "--out", false, root), /must be a file inside/);
});

test(
  "insideProject on Windows: backslashes are separators and case does not matter",
  { skip: process.platform !== "win32" ? "windows paths" : false },
  () => {
    const root = join(tmpdir(), "Project");
    assert.throws(() => insideProject("..\\outside.json", "--out", root), /--out must be a file inside/);
    assert.equal(insideProject(`${root}\\REPORT.json`, "--out", root), `${root}\\REPORT.json`);
  },
);

test("guardNoxevalFile: only a noxeval report, summary or review file is overwritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noxeval-guard-"));
  await guardNoxevalFile(join(dir, "new.json"), "new.json", "report");
  await writeFile(join(dir, "noxeval-report.json"), JSON.stringify(report([res("a")])));
  await guardNoxevalFile(join(dir, "noxeval-report.json"), "noxeval-report.json", "report");
  await writeFile(join(dir, "noxeval-summary.md"), "## noxeval: 1/1 passed ✅\n");
  await guardNoxevalFile(join(dir, "noxeval-summary.md"), "noxeval-summary.md", "summary");
  await writeFile(
    join(dir, "noxeval-review.json"),
    JSON.stringify({ runAt: "t", startedAt: "t", reviewedAt: null, judge: null, items: [] }),
  );
  await guardNoxevalFile(join(dir, "noxeval-review.json"), "noxeval-review.json", "review");

  await writeFile(join(dir, "notes.json"), '{"mine": true}');
  await assert.rejects(
    () => guardNoxevalFile(join(dir, "notes.json"), "notes.json", "report"),
    /notes.json exists and is not a noxeval report file/,
  );
  await assert.rejects(
    () => guardNoxevalFile(join(dir, "notes.json"), "notes.json", "review"),
    /notes.json exists and is not a noxeval review file/,
  );
  await writeFile(join(dir, "notes.md"), "# my notes\n");
  await assert.rejects(
    () => guardNoxevalFile(join(dir, "notes.md"), "notes.md", "summary"),
    /notes.md exists and is not a noxeval summary file/,
  );
  await writeFile(join(dir, "broken.json"), "{oops");
  await assert.rejects(
    () => guardNoxevalFile(join(dir, "broken.json"), "broken.json", "report"),
    /broken.json exists and is not a noxeval report file/,
  );

  assert.equal(isNoxevalReport(JSON.parse(await readFile(join(dir, "noxeval-report.json"), "utf8"))), true);
  assert.equal(isReviewFile(JSON.parse(await readFile(join(dir, "noxeval-review.json"), "utf8"))), true);
  assert.equal(isNoxevalSummary(await readFile(join(dir, "noxeval-summary.md"), "utf8")), true);
});

test("run paths stay inside the project, and no file that is not noxeval's is overwritten", async () => {
  const { dir, parent } = await project();
  const app = await fakeServer((_body, _req, res) => json(res, { answer: "We're open from 9am to 6pm." }));
  try {
    await writeFile(join(dir, "noxeval.config.mjs"), httpConfig(`${app.url}/chat`));
    const outside = await cli(["run", "--out", "../outside.json"], dir);
    assert.equal(outside.code, 2);
    assert.match(outside.out, /--out must be a file inside /);
    assert.equal(app.seen.length, 0, "refused before any call to the app");
    assert.equal(await exists(join(parent, "outside.json")), false);
    const markdown = await cli(["run", "--markdown", "../outside.md"], dir);
    assert.equal(markdown.code, 2);
    assert.match(markdown.out, /--markdown must be a file inside /);
    assert.equal(app.seen.length, 0);
    await writeFile(join(dir, "noxeval.config.mjs"), httpConfig(`${app.url}/chat`, "../outside.json"));
    const configured = await cli(["run"], dir);
    assert.equal(configured.code, 2);
    assert.match(configured.out, /report in the config must be a file inside /);
    assert.equal(app.seen.length, 0);
    await writeFile(join(dir, "noxeval.config.mjs"), httpConfig(`${app.url}/chat`));

    await mkdir(join(dir, "sub"));
    const inside = await cli(["run", "--out", "sub/report.json", "--markdown", "sub/report.md"], dir);
    assert.equal(inside.code, 0, inside.out);
    assert.match(await readFile(join(dir, "sub/report.md"), "utf8"), /## noxeval: 1\/1 passed/);
    const allow = await cli(["run", "--allow-outside", "--out", "../outside.json"], dir);
    assert.equal(allow.code, 0, allow.out);
    assert.equal(isNoxevalReport(JSON.parse(await readFile(join(parent, "outside.json"), "utf8"))), true);

    await writeFile(join(parent, "outside.json"), '{"mine": true}');
    const clobberOutside = await cli(["run", "--allow-outside", "--out", "../outside.json"], dir);
    assert.equal(clobberOutside.code, 2, "the opt-out skips the folder check, not the overwrite guard");
    assert.match(clobberOutside.out, /outside.json exists and is not a noxeval report file/);
    assert.equal(await readFile(join(parent, "outside.json"), "utf8"), '{"mine": true}');
    await writeFile(join(dir, "notes.json"), '{"mine": true}');
    const clobber = await cli(["run", "--out", "notes.json"], dir);
    assert.equal(clobber.code, 2);
    assert.match(clobber.out, /notes.json exists and is not a noxeval report file/);
    assert.equal(await readFile(join(dir, "notes.json"), "utf8"), '{"mine": true}');
    const rerun = await cli(["run"], dir);
    assert.equal(rerun.code, 0, rerun.out);
  } finally {
    await app.close();
  }
});

test("review paths stay inside the project, and a broken review file is never silently replaced", async () => {
  const { dir, parent } = await project();
  await writeFile(join(dir, "noxeval-report.json"), JSON.stringify(report([res("a")])));
  assert.equal((await cli(["review", "--report", "../report.json"], dir)).code, 2);
  assert.match((await cli(["review", "--report", "../report.json"], dir)).out, /--report must be a file inside /);
  assert.match((await cli(["review", "--file", "../review.json"], dir)).out, /--file must be a file inside /);

  await writeFile(join(dir, "notes.json"), '{"mine": true}');
  const foreign = await cli(["review", "--report", "notes.json"], dir);
  assert.equal(foreign.code, 2);
  assert.match(foreign.out, /notes.json is not a noxeval report/);
  await writeFile(join(dir, "broken.json"), "{oops");
  const broken = await cli(["review", "--report", "broken.json"], dir);
  assert.equal(broken.code, 2);
  assert.match(broken.out, /broken\.json: /);

  await writeFile(join(dir, "noxeval-review.json"), "{oops");
  const reviewFile = await cli(["review"], dir);
  assert.equal(reviewFile.code, 2);
  assert.match(reviewFile.out, /noxeval-review\.json: .*Delete the file to start over/);
  assert.equal(await readFile(join(dir, "noxeval-review.json"), "utf8"), "{oops", "the grades file is not overwritten");
  await writeFile(join(dir, "noxeval-review.json"), '{"mine": true}');
  assert.match((await cli(["review"], dir)).out, /noxeval-review\.json is not a noxeval review file/);
  assert.equal(await readFile(join(dir, "noxeval-review.json"), "utf8"), '{"mine": true}');

  await writeFile(join(parent, "report.json"), JSON.stringify(report([res("a")])));
  const allow = await cli(["review", "--allow-outside", "--report", "../report.json", "--file", "../review.json"], dir, "q\n");
  assert.equal(allow.code, 0, allow.out);
  assert.equal(isReviewFile(JSON.parse(await readFile(join(parent, "review.json"), "utf8"))), true);
  assert.equal(await readFile(join(dir, "noxeval-review.json"), "utf8"), '{"mine": true}', "the file inside the project was not touched");
});
