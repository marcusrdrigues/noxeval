// @ts-check
import { defineConfig, httpTarget } from "noxeval";
// import { openaiJudge } from "noxeval";

export default defineConfig({
  target: httpTarget({ url: "http://localhost:3999/api/chat", answerPath: "answer", contextPath: "context", name: "bookstore example" }),
  cases: "./noxeval.cases.json",
  // judge: openaiJudge({ model: "<pinned model id>" }),
  // planted: "./noxeval.planted.json",
  checks: {
    allowedLinks: ["example.com"],
    leakMarkers: ["You are Ava"],
  },
});
