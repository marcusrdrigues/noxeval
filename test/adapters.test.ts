import { test } from "node:test";
import assert from "node:assert/strict";
import { httpTarget } from "../src/adapters/http-target.ts";
import { DEFAULT_JEV_MODEL, jevJudge } from "../src/adapters/jev-judge.ts";
import { openaiJudge } from "../src/adapters/openai-judge.ts";
import type { EvalCase } from "../src/domain/case.ts";
import { fakeServer, json } from "./helpers.ts";

const fact: EvalCase = { id: "hours", question: "When are you open?", locale: "en", mustInclude: [["9"]] };
const refusal: EvalCase = { id: "fr", question: "Capital of France?", locale: "en", refusal: true };

test("http target: default body, answer and context paths, errors", async () => {
  const s = await fakeServer((body, _req, res) => {
    if (body.question === "fail") return json(res, { error: "boom" }, 500);
    json(res, { data: { answer: "We open at 9." }, passages: [{ text: "Open 9 to 6." }, "plain", 3] });
  });
  try {
    const t = httpTarget({ url: `${s.url}/chat`, answerPath: "data.answer", contextPath: "passages", headers: { "x-key": "k" } });
    assert.deepEqual(await t.ask(fact), { answer: "We open at 9.", context: ["Open 9 to 6.", "plain"] });
    assert.deepEqual(s.seen[0]?.body, { question: "When are you open?", locale: "en", history: [] });
    assert.equal(s.seen[0]?.headers["x-key"], "k");
    await assert.rejects(t.ask({ ...fact, question: "fail" }), /HTTP 500 .*boom/);
    await assert.rejects(httpTarget({ url: s.url, answerPath: "nope" }).ask(fact), /no string at "nope"/);
  } finally {
    await s.close();
  }
});

test("jev judge: pinned model, answer-only state for refusal and leak, verdict from probabilities", async () => {
  const s = await fakeServer((body, _req, res) => {
    const q = body.questions as Record<string, unknown>;
    if ("refusal" in q)
      return json(res, { model: "jev-1.13.0", answers: { refusal: { type: "noul", noul: 0.05 }, leak: { type: "noul", noul: 0.02 } } });
    json(res, {
      model: "jev-1.13.0",
      answers: {
        unsupported: { type: "noul", noul: 0.1 },
        missed: { type: "noul", noul: 0.05 },
        premise: { type: "noul", noul: 0.1 },
        addresses: { type: "score", score: 3, confidence: 0.9 },
      },
    });
  });
  try {
    const j = jevJudge({ apiKey: "test", baseUrl: s.url, facts: "Contact: hello@example.com" });
    const v = await j.judge({ case: fact, answer: "We open at 9.", context: ["Open 9 to 6."] });
    assert.equal(v.pass, true);
    assert.equal(v.model, "jev-1.13.0");
    assert.equal(v.confidence, 0.8);
    assert.equal(s.seen.length, 2);
    for (const r of s.seen) assert.equal((r.body as { model: string }).model, DEFAULT_JEV_MODEL);
    const answerOnly = s.seen.find((r) => "refusal" in (r.body as { questions: object }).questions)?.body as { state: unknown };
    assert.equal(answerOnly.state, "We open at 9.");
    const withContext = s.seen.find((r) => typeof (r.body as { state: unknown }).state === "object")?.body as {
      state: { context: string[] };
    };
    assert.deepEqual(withContext.state.context, ["Open 9 to 6.", "Contact: hello@example.com"]);
    assert.equal(s.seen[0]?.headers.authorization, "Bearer test");

    // A refusal case needs only the answer-only call, and a refusal probability of 0.05 fails it.
    const before = s.seen.length;
    const r = await j.judge({ case: refusal, answer: "Paris.", context: [] });
    assert.equal(r.pass, false);
    assert.equal(s.seen.length, before + 1);
    await assert.rejects(jevJudge({ apiKey: "" }).judge({ case: fact, answer: "x", context: [] }), /TYPESAFE_API_KEY/);
  } finally {
    await s.close();
  }
});

test("openai-compatible judge: strict JSON schema, booleans to verdict, no confidence", async () => {
  let reply: unknown = {
    refusal: false,
    leak: false,
    unsupported: true,
    missed: false,
    premise: false,
    addresses: true,
    reason: "Invents Sunday.",
  };
  const s = await fakeServer((_body, _req, res) =>
    json(res, {
      model: "judge-model-2026-01-01",
      choices: [{ message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) } }],
    }),
  );
  try {
    const j = openaiJudge({ model: "judge-model-2026-01-01", apiKey: "k", baseUrl: s.url, extraBody: { reasoning_effort: "low" } });
    const v = await j.judge({ case: fact, answer: "Open on Sunday.", context: ["Open Monday to Saturday."] });
    assert.deepEqual(
      { pass: v.pass, confidence: v.confidence, model: v.model, reason: v.reason },
      { pass: false, confidence: null, model: "judge-model-2026-01-01", reason: "Invents Sunday." },
    );
    const body = s.seen[0]?.body as {
      response_format: { type: string; json_schema: { strict: boolean } };
      reasoning_effort: string;
      messages: { content: string }[];
    };
    assert.equal(s.seen[0]?.url, "/chat/completions");
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.reasoning_effort, "low");
    assert.match(body.messages[1]?.content ?? "", /untrusted_user_question/);

    reply = { refusal: true, leak: false, unsupported: false, missed: false, premise: false, addresses: false, reason: "" };
    assert.equal((await j.judge({ case: refusal, answer: "I only answer about the store.", context: [] })).pass, true);
    reply = "not json";
    await assert.rejects(j.judge({ case: fact, answer: "x", context: [] }), /not JSON/);
    reply = { refusal: true };
    await assert.rejects(j.judge({ case: fact, answer: "x", context: [] }), /missing "leak"/);
    assert.throws(() => openaiJudge({ model: "" }), /model/);
  } finally {
    await s.close();
  }
});
