// @ts-check
import { defineConfig, jsonlTarget } from "noxeval";

export default defineConfig({
  // The app wrote these answers with its own code path (any language): one JSON object per line, no endpoint needed.
  target: jsonlTarget(new URL("./answers.jsonl", import.meta.url), { name: "consumer-law assistant (recorded)" }),
  cases: "./noxeval.cases.json",
  checks: { grounding: "report" },
});
