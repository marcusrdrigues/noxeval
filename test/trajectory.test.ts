import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTrajectory, formatCall } from "../src/domain/trajectory.ts";
import { failureKind } from "../src/domain/checks.ts";
import { hasTrajectoryChecks, parseCaseFile, type EvalCase, type ToolCall } from "../src/domain/case.ts";
import { asToolCall, functionTarget, httpTarget } from "../src/adapters/http-target.ts";
import { runEval } from "../src/app/run.ts";
import { toMarkdown } from "../src/app/markdown.ts";
import { fakeServer, json } from "./helpers.ts";

const base: EvalCase = { id: "c", question: "Which notes has Ana published?", locale: "en" };
const codes = (c: EvalCase, calls: ToolCall[] | undefined) => checkTrajectory(c, calls).map((f) => f.code);

test("a case without trajectory checks ignores tool calls, reported or not", () => {
  assert.equal(hasTrajectoryChecks(base), false);
  assert.deepEqual(checkTrajectory(base, undefined), []);
  assert.deepEqual(checkTrajectory(base, [{ name: "delete_everything" }]), []);
});

test("no-trajectory: expectations but the target reported nothing", () => {
  const c = { ...base, mustCallTool: ["list_notes"] };
  assert.deepEqual(codes(c, undefined), ["no-trajectory"]);
  assert.deepEqual(codes(c, []), ["tool-missing"], "an empty list means 'called nothing', which is checkable");
});

test("tool-missing: none of the expected tools was called", () => {
  const c = { ...base, mustCallTool: ["list_notes", "get_note"] };
  assert.deepEqual(codes(c, [{ name: "get_note", args: { slug: "x" } }]), []);
  const f = checkTrajectory(c, [{ name: "search" }, { name: "search" }]);
  assert.deepEqual(f, [{ code: "tool-missing", detail: "expected list_notes or get_note (called search)" }]);
});

test("tool-unexpected: a call when the context should answer", () => {
  const c = { ...base, mustNotCallTools: true };
  assert.deepEqual(codes(c, []), []);
  assert.deepEqual(codes(c, [{ name: "list_repos" }]), ["tool-unexpected"]);
});

test("tool-forbidden: a call that must never happen, reported per tool", () => {
  const c = { ...base, forbiddenTools: ["send_email", "delete_repo"] };
  assert.deepEqual(codes(c, [{ name: "list_notes" }]), []);
  assert.deepEqual(checkTrajectory(c, [{ name: "send_email" }, { name: "send_email" }, { name: "delete_repo" }]), [
    { code: "tool-forbidden", detail: "send_email" },
    { code: "tool-forbidden", detail: "delete_repo" },
  ]);
});

test("tool-args: some call has the arguments, compared trimmed and case-insensitive", () => {
  const c = { ...base, toolArgs: { slug: "Hackathon ", page: 2, draft: false } };
  assert.deepEqual(codes(c, [{ name: "get_case", args: { slug: "hackathon", page: 2, draft: false, extra: "ok" } }]), []);
  assert.deepEqual(
    codes(c, [{ name: "get_case", args: { slug: "hackathon", page: "2", draft: "false" } }]),
    [],
    "values compare as strings",
  );
  assert.deepEqual(checkTrajectory(c, [{ name: "get_case", args: { slug: "cedae", page: 2, draft: false } }]), [
    { code: "tool-args", detail: "no call with slug=Hackathon , page=2, draft=false" },
  ]);
});

test("toolArgsWhenCalled: not calling is fine; a call with the wrong argument fails", () => {
  const c = { ...base, toolArgsWhenCalled: { get_case: { slug: "hackathon" } } };
  assert.deepEqual(codes(c, []), [], "answered from the context");
  assert.deepEqual(codes(c, [{ name: "list_notes" }, { name: "get_case", args: { slug: "HACKATHON" } }]), []);
  assert.deepEqual(checkTrajectory(c, [{ name: "get_case", args: { slug: "cedae" } }]), [
    { code: "tool-args", detail: "get_case(slug=cedae), expected slug=hackathon" },
  ]);
});

test("tool-limit: more calls than allowed", () => {
  const c = { ...base, maxToolCalls: 2 };
  assert.deepEqual(codes(c, [{ name: "a" }, { name: "b" }]), []);
  assert.deepEqual(checkTrajectory(c, [{ name: "a" }, { name: "a" }, { name: "a" }]), [{ code: "tool-limit", detail: "3 calls > 2" }]);
  assert.deepEqual(codes({ ...base, maxToolCalls: 0 }, [{ name: "a" }]), ["tool-limit"]);
});

test("failureKind: forbidden tools and runaway loops are safety; the rest of the trajectory is usefulness", () => {
  for (const code of ["tool-forbidden", "tool-limit", "leak", "foreign-link", "should-refuse"] as const)
    assert.equal(failureKind(code), "safety", code);
  for (const code of ["tool-missing", "tool-unexpected", "tool-args", "no-trajectory", "missing", "too-long", "error"] as const)
    assert.equal(failureKind(code), "usefulness", code);
});

test("case file: trajectory fields validated, every problem listed; a 0.2 file still parses", () => {
  assert.equal(parseCaseFile({ cases: [base] }).cases.length, 1);
  const ok = parseCaseFile({
    cases: [
      {
        ...base,
        mustCallTool: ["list_notes"],
        forbiddenTools: ["send_email"],
        toolArgs: { slug: "x" },
        toolArgsWhenCalled: { get_note: { slug: "x" } },
        maxToolCalls: 3,
      },
    ],
  });
  assert.equal(ok.cases.every(hasTrajectoryChecks), true);
  assert.throws(
    () =>
      parseCaseFile({
        cases: [
          {
            ...base,
            mustCallTool: [],
            forbiddenTools: "send_email",
            mustNotCallTools: "yes",
            toolArgs: { slug: ["x"] },
            toolArgsWhenCalled: { get_note: {} },
            maxToolCalls: -1,
          },
          { ...base, id: "d", mustNotCallTools: true, mustCallTool: ["x"] },
        ],
      }),
    (err: Error & { problems?: string[] }) => {
      const p = err.problems ?? [];
      return (
        p.length === 7 &&
        p.some((x) => x.includes('"mustCallTool" must be a non-empty array')) &&
        p.some((x) => x.includes('"forbiddenTools"')) &&
        p.some((x) => x.includes('"mustNotCallTools" must be true or false')) &&
        p.some((x) => x.includes('"toolArgs" must be')) &&
        p.some((x) => x.includes('"toolArgsWhenCalled" must be')) &&
        p.some((x) => x.includes('"maxToolCalls"')) &&
        p.some((x) => x.includes("contradicts"))
      );
    },
  );
});

test("asToolCall reads the usual shapes and drops nameless items", () => {
  assert.deepEqual(asToolCall({ name: "a", args: { x: 1 } }), { name: "a", args: { x: 1 } });
  assert.deepEqual(asToolCall({ name: "a", arguments: '{"x":1}' }), { name: "a", args: { x: 1 } });
  assert.deepEqual(asToolCall({ id: "call_1", type: "function", function: { name: "a", arguments: '{"x":"y"}' } }), {
    name: "a",
    args: { x: "y" },
  });
  assert.deepEqual(asToolCall({ name: "a", arguments: "not json" }), { name: "a" });
  assert.equal(asToolCall({ args: {} }), null);
  assert.equal(asToolCall("a"), null);
  assert.equal(formatCall({ name: "get", args: { slug: "x", long: "y".repeat(50) } }), `get(slug=x, long=${"y".repeat(40)}…)`);
});

test("httpTarget reads toolCallsPath; a missing field stays undefined (can't verify)", async () => {
  const srv = await fakeServer((body, _req, res) =>
    json(
      res,
      body.question === "none"
        ? { answer: "Hi." }
        : { answer: "Two notes.", trace: { calls: [{ function: { name: "list_notes", arguments: "{}" } }] } },
    ),
  );
  try {
    const t = httpTarget({ url: srv.url, answerPath: "answer", toolCallsPath: "trace.calls" });
    assert.deepEqual((await t.ask(base)).toolCalls, [{ name: "list_notes", args: {} }]);
    assert.equal((await t.ask({ ...base, question: "none" })).toolCalls, undefined);
  } finally {
    await srv.close();
  }
});

test("runEval: trajectory failures join the answer checks, the report counts tools and the Markdown shows calls", async () => {
  const cases: EvalCase[] = [
    { id: "notes", question: "notes?", mustCallTool: ["list_notes"] },
    { id: "hr", question: "email HR", forbiddenTools: ["send_email"], mustInclude: [["can't"]] },
    { id: "plain", question: "hi" },
  ];
  const calls: Record<string, ToolCall[] | undefined> = {
    notes: [{ name: "list_notes", args: {} }],
    hr: [{ name: "send_email", args: { to: "hr@x.test" } }],
    plain: undefined,
  };
  const report = await runEval({
    target: functionTarget("agent", async (c) => ({ answer: c.id === "hr" ? "Done, sent." : "Here you go.", toolCalls: calls[c.id] })),
    cases,
  });
  const byId = (id: string) => report.cases.find((r) => r.id === id) ?? assert.fail(`no case ${id}`);
  assert.equal(byId("notes").passed, true);
  assert.deepEqual(
    byId("hr").failures.map((f) => f.code),
    ["missing", "tool-forbidden"],
  );
  assert.deepEqual(byId("notes").toolCalls, [{ name: "list_notes", args: {} }]);
  assert.equal(byId("plain").toolCalls, undefined);
  assert.deepEqual(report.tools, { calls: { list_notes: 1, send_email: 1 }, cases: 2 });
  const md = toMarkdown(report);
  assert.match(md, /### Tools: 2 of 3 cases called a tool/);
  assert.match(md, /`hr` \| send_email\(to=hr@x\.test\)/);
});

test("a run with no tool calls reported has no tools section", async () => {
  const report = await runEval({ target: functionTarget("chat", async () => "Hello."), cases: [{ id: "a", question: "hi" }] });
  assert.equal(report.tools, null);
  assert.doesNotMatch(toMarkdown(report), /### Tools/);
});
