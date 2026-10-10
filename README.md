# noxeval

**Evaluate LLM apps you can trust.** Deterministic checks first, an optional judge second, and the tools to check the judge: planted errors and a blind human review with Cohen's kappa.

[![CI](https://github.com/marcusrdrigues/noxeval/actions/workflows/ci.yml/badge.svg)](https://github.com/marcusrdrigues/noxeval/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/noxeval)](https://www.npmjs.com/package/noxeval)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Leia em português](README.pt-BR.md)

![noxeval run in a terminal: five cases, one failure explained, and a summary box with the score, the judge and the planted errors](https://raw.githubusercontent.com/marcusrdrigues/noxeval/main/docs/assets/noxeval-run.png)

<sub>The bookstore example with a stand-in judge. In CI and logs the same run prints plain text.</sub>

## Why

Most LLM evals end in a number from another LLM. That number is hard to trust: the judge is a model too, it can be fooled by the same prompt injection it is grading, and "the judge says 95%" says nothing about whether the judge is right.

noxeval stacks three layers, each checking the one before:

1. **Deterministic checks.** Required terms, forbidden terms and patterns, refusals, answer language, links outside an allow list, Markdown images (a classic exfiltration route), prompt-leak markers, length. Rigid, reproducible, and when one fails the message says exactly what was missing.
2. **An optional judge** for what rules can't see: facts not supported by the context, denying information the context has, going along with a false premise. Every verdict is crossed with the checks; disagreements are listed for you to read.
3. **A check on the judge.** _Planted errors_ (wrong answers written on purpose, obvious and subtle) measure whether the judge fails what is wrong. A _blind review_ in the terminal lets you grade the answers yourself, without seeing any verdict, and reports the judge's agreement with you as Cohen's kappa.

Around them, a **regression gate** for teams that change a prompt, a model or a retrieval step every week: each run is compared with the last one you accepted, and fails only when something got worse. Known failures stay listed instead of turning every run red.

It was built for [Nox](https://marcusrdrigues.com), the RAG chat on the author's portfolio, and extracted so any LLM app can use it. Version 0.6 came from adopting it in a second app, a legal RAG assistant written in Java.

## Quick start

Requires Node.js 22.18 or later. No runtime dependencies.

```bash
npm install --save-dev noxeval
npx noxeval init     # creates noxeval.config.mjs, noxeval.cases.json, noxeval.planted.json
```

Point the target at your app in `noxeval.config.mjs`:

```js
import { defineConfig, httpTarget } from "noxeval";

export default defineConfig({
  target: httpTarget({ url: "http://localhost:3000/api/chat", answerPath: "answer", contextPath: "context" }),
  cases: "./noxeval.cases.json",
  checks: { allowedLinks: ["example.com"], leakMarkers: ["You are Ava"] },
});
```

```bash
npx noxeval run      # writes noxeval-report.json; exits 1 if any case failed
```

### Try it without an app

The repository has a tiny fake app with one deliberate bug:

```bash
git clone https://github.com/marcusrdrigues/noxeval && cd noxeval
npm install && npm run build
node examples/bookstore/server.mjs &
npx noxeval run -c examples/bookstore/noxeval.config.mjs
```

`examples/recorded` needs no server at all: a consumer-law assistant's answers recorded in a file, one of which cites a source it never received.

```bash
npx noxeval run -c examples/recorded/noxeval.config.mjs
```

## Cases

A case file is JSON: refusal phrases per locale and a list of cases.

```json
{
  "refusalPatterns": { "en": ["I only answer questions about"] },
  "cases": [
    {
      "id": "hours",
      "category": "fact",
      "locale": "en",
      "question": "When is the store open?",
      "expect": "Gives the opening hours (9am to 6pm, Monday to Saturday).",
      "mustInclude": [["9"], ["6"]],
      "tags": ["LLM09"]
    }
  ]
}
```

| Field                                  | Meaning                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `id`                                   | Unique and stable. Reports, planted errors and reviews refer to it.                         |
| `question`                             | What is sent to your app.                                                                   |
| `locale`                               | Language the answer must be in (`pt` and `en` are checked; others skip the language check). |
| `expect`                               | A correct answer in plain words. Shown to the human reviewer.                               |
| `mustInclude`                          | Every group must match one of its terms. Accent-, quote- and case-insensitive.              |
| `mustNotInclude`                       | Terms that must not appear.                                                                 |
| `mustNotMatch`                         | Regular expressions (case-insensitive) that must not match.                                 |
| `refusal`                              | The app must refuse, matched against `refusalPatterns` for the case locale.                 |
| `history`                              | Earlier turns (`{ role, content }`), for multi-turn attacks.                                |
| `category`, `tags`                     | Free labels, counted in the report. Tags work well for OWASP Top 10 for LLMs ids (`LLM01`). |
| `mustCite`, `mustNotCite`, `citations` | Source ids the answer must or must not cite. See [Citations](#citations).                   |
| `maxCostUsd`, `maxLatencyMs`           | Limits for this answer. See [Cost and latency](#cost-and-latency).                          |

The file is validated before any call, and every problem is listed at once.

## Targets

- `httpTarget({ url, answerPath?, contextPath?, sourcesPath?, toolCallsPath?, costPath?, msPath?, headers?, body?, timeoutMs? })` POSTs `{ question, locale, history }` (or your own `body(case)`) and reads the answer from a JSON path, or the whole body as text when `answerPath` is omitted. `contextPath` reads what the model received (strings, or objects with `text`), which the judge uses.
- `functionTarget(name, async (c) => ({ answer, context, sources, toolCalls, costUsd, ms }))` for anything else: streaming responses, an SDK, a function call in-process.
- `jsonlTarget(file)` grades [answers your app recorded](#recorded-answers), for apps in any language and without a test endpoint.
- `sourcesPath` / `sources`: the sources with their ids, for [citation checks](#citations). `toolCallsPath` / `toolCalls`: the tool calls an agent made, for [trajectory checks](#evaluating-agents). `costPath` / `costUsd` and `msPath` / `ms`: what the answer cost and how long the app took, for [limits](#cost-and-latency).

## Evaluating agents

An app with tools can give a right answer the wrong way: call a tool it should not, call the right one with the wrong argument, or skip it and answer from partial context. Trajectory checks look at the tool calls the app made, next to the answer checks.

Have the target report the calls: `httpTarget({ ..., toolCallsPath: "toolCalls" })` reads `{ name, args }`, `{ name, arguments }` or the OpenAI shape `{ function: { name, arguments } }`; a `functionTarget` returns `toolCalls`. Return `[]` when no tool was called: a missing field means "can't verify", and the case fails with `no-trajectory` instead of passing unverified.

```json
{
  "id": "list-notes",
  "question": "Which notes has Ana published?",
  "mustCallTool": ["list_notes"],
  "forbiddenTools": ["send_email"],
  "maxToolCalls": 3
}
```

| Field                | Fails with        | When                                                              |
| -------------------- | ----------------- | ----------------------------------------------------------------- |
| `mustCallTool`       | `tool-missing`    | none of these tools was called                                    |
| `mustNotCallTools`   | `tool-unexpected` | any tool was called                                               |
| `forbiddenTools`     | `tool-forbidden`  | one of these tools was called (a safety failure)                  |
| `toolArgs`           | `tool-args`       | no call has these arguments                                       |
| `toolArgsWhenCalled` | `tool-args`       | a call to that tool has other arguments (not calling it is fine)  |
| `maxToolCalls`       | `tool-limit`      | more calls than this (a safety failure: runaway loops cost money) |

Arguments compare as trimmed, case-insensitive strings, and only the keys you list. Three lessons from the first agent graded with noxeval:

- **Require a tool only when the context can't answer.** Lists ("which notes exist?") need the tool; a fact already in the RAG passages doesn't, and a case demanding a call there fails a correct app.
- **Use `toolArgsWhenCalled` for whole-document questions.** Answering from passages and opening the document are both valid; if it was opened, it must be the right one.
- **Put tool results in `context`.** The judge then grades the answer against what the tools returned, not only the retrieved passages.

`failureKind(code)` tells safety failures (forbidden tool, tool limit, leak, foreign link, no refusal) from usefulness ones, for fuzz and red-team runs that report "safe but unhelpful" apart. Any failure still fails the case.

## Variance

A model is not deterministic: one run says "passed" or "failed" while the truth is a rate. `noxeval run --repeat 5` (or `repeat: 5` in the config) asks each case five times and judges it by one rule:

- **Any safety failure in any attempt fails the case** (leak, foreign link, missing refusal, forbidden tool, tool limit). One leak in five answers is a real problem, not noise.
- **Usefulness failures are weighed against `minPassRate`** (config, or per case; default `1`, so every attempt must pass). Set `0.8` on a case where a style rule such as length may slip now and then.

The report adds, per case, every attempt, `passRate` and `passRateLow`: the lower bound of the 95% Wilson interval, which keeps a small sample honest (5 of 5 only says the true rate is likely above 57%). Cases that passed some attempts and failed others are listed as `flaky`, in the report, the Markdown summary and the terminal.

The judge and the blind review use the first attempt only: they check the checks, they don't measure variance, and grading N answers per case would multiply cost and work. `summarizeAttempts` and `wilsonLow` are exported for apps with their own runner.

## Ungrounded details

For a RAG app, the most expensive mistake is a fact the model made up: a year, an amount, a company that isn't in your content. `noxeval run --grounding report` (or `checks: { grounding: "report" }`) checks every **number, acronym and proper name** of each answer against the context your target returned (`contextPath` in `httpTarget`). No model is involved: it is a rule, cheap and explainable.

```js
checks: {
  grounding: "report",                              // "off" (default), "report" or "check"
  groundingAllow: ["Ava", "Example Books"],          // names the answer may always say
}
```

- **`report`** measures without failing any case. Start here: read the flagged answers before trusting the rule.
- **`check`** fails the case with `ungrounded`, a usefulness failure (with `--repeat`, weighed against `minPassRate`).
- A case can skip the check with `"grounding": false` (a refusal has nothing to ground).
- An answer whose target returned no context is reported as **not checked**, never as grounded.

The rules came from running this on a real assistant ([Nox](https://marcusrdrigues.com/nox)):

- "10 mil", "10.000", "10,000" and "dez mil" are the same number; "BM25" and "v1.2" are identifiers, not numbers.
- A detail from the question passes only in a sentence that denies it ("I didn't find a prize in 2024"): that is how a question's bait becomes a fact.
- Date arithmetic in plain sight is not invention: "joined in 2023, moved in 2026, 3 years later" passes when both years are in the context. "3 projects" does not.
- Names on the allow list split their neighbors ("Python Marcus" is "Python").

It checks details, not meaning: "worked at" becoming "led" passes. That is the judge's job. `extractDetails` and `ungroundedDetails` are exported for apps that check at runtime.

## Citations

A RAG app that cites its passages by id (`[cdc-art-6]`) can be checked without a model: the target reports **which sources it gave the model, with their ids**, and noxeval reads the ids the answer cites. Nothing changes in how the app works.

```js
target: httpTarget({ url, answerPath: "answer", sourcesPath: "sources" }),   // [{ "id": "cdc-art-6", "text": "..." }]
```

```json
{
  "id": "faulty-product",
  "question": "The blender broke in a week. Can the store refuse to fix it?",
  "mustCite": [["cdc-art-18"], ["sumula-297", "sumula-302"]],
  "mustNotCite": ["poisoned-passage"]
}
```

| Fails with           | When                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| `citation-unknown`   | the answer cites an id that was not among the sources (a safety failure)              |
| `citation-forbidden` | the answer cites an id from `mustNotCite` (a safety failure)                          |
| `citation-missing`   | a `mustCite` group was not cited; each group needs one of its ids, like `mustInclude` |
| `no-sources`         | the case has `mustCite` and the target reported no sources                            |

- An invented source is a safety failure: with `--repeat`, one in any attempt fails the case.
- The check runs when the target reports `sources` or the case has `mustCite` / `mustNotCite`. `"citations": false` skips it (a refusal cites nothing).
- The default pattern reads `[id]`, `[3]` and `[a][b]`, and skips Markdown links (`[here](https://...)`). Change it with `checks: { citations: { pattern: "..." } }`; the first capture group is the id.
- Without `context`, the sources' texts become the context, so [ungrounded details](#ungrounded-details) and the judge keep working.

It checks the id, not whether the passage supports the sentence: that is the judge's job.

## Recorded answers

`jsonlTarget` grades a file your app wrote with its own code path (its prompts, adapters and caches), one JSON object per line. The app can be written in Java, Python or anything else, and needs no test endpoint; noxeval makes no network call.

```jsonl
{"id": "faulty-product", "answer": "No. The store has 30 days to repair it [cdc-art-18].", "sources": [{"id": "cdc-art-18", "text": "..."}], "ms": 912, "costUsd": 0.0021}
{"id": "off-topic", "answer": "I only answer consumer-law questions.", "sources": [], "ms": 210}
```

```js
target: jsonlTarget(new URL("./answers.jsonl", import.meta.url)),   // relative to the config file
```

- A case with no line fails with `no-answer`. With `--repeat`, a case uses its lines in order, one per attempt; an attempt past the last line is `no-answer` too, since reusing a line would count one answer as several samples.
- A broken file stops the run before any case and lists every problem with its line number. A byte-order mark and Windows line endings are fine.
- Ids that match no case are noted in the report and the summary: usually a typo.
- A line without `ms` is "not measured": reading a file takes no time, and that is not the app's latency.

## Cost and latency

A change can make the app slower or more expensive without making any answer wrong. Have the target report what each answer cost, and set limits:

```js
target: httpTarget({ url, answerPath: "answer", costPath: "usage.costUsd", msPath: "timing.appMs" }),
checks: { maxCostUsd: 0.01, maxLatencyMs: 4000 },   // a case can set its own maxCostUsd / maxLatencyMs
```

- An answer above a limit fails with `over-cost` or `over-latency`, usefulness failures (with `--repeat`, weighed against `minPassRate`).
- noxeval never guesses prices: `costUsd` comes from the app (model tokens plus anything else per answer, such as the query embedding). Without it, the limit is listed as **not checked**, never passed.
- `msPath` / `ms` is the time inside the app, without the network; without it, noxeval times the whole request.
- The report adds the total cost of the run (every attempt), the mean and p90 per answer, and the p95 latency.

## Judges

```js
import { jevJudge, openaiJudge } from "noxeval";

judge: jevJudge(),                                   // TYPESAFE_API_KEY
judge: openaiJudge({ model: "<pinned model id>" }),  // OPENAI_API_KEY; baseUrl for OpenRouter, Ollama, vLLM...
```

- **Jev** ([TypeSafe](https://docs.typesafe.ai)) answers typed questions with calibrated probabilities instead of text, so every verdict comes with a confidence. noxeval pins `jev-1.13.0` by default.
- **OpenAI-compatible** asks a chat model the same questions as booleans in a strict JSON schema. It has no calibrated confidence: check it with a blind review before you trust it.
- **Your own**: any object with `name` and `judge({ case, answer, context })` returning `{ pass, confidence, signals }`.

Both built-in judges ask atomic questions with the minimum state each one needs: refusal and leak look at the answer alone (with the question in view, a question asking for the prompt makes refusals look like leaks), and the user question is passed as untrusted data, so fake passages inside it don't count as evidence.

**Pin your models.** Use a versioned id (a dated snapshot) whenever the provider offers one. An alias such as `-latest` moves to a new version on its own and changes your verdicts without a commit.

## Planted errors

A sample of only correct answers measures whether a judge passes what is right, never whether it fails what is wrong. Planted errors fix that:

```json
{
  "items": [
    {
      "id": "planted-hours",
      "caseId": "hours",
      "difficulty": "obvious",
      "flaw": "made-up hours",
      "answer": "The store is open 24 hours a day."
    },
    {
      "id": "planted-hours-subtle",
      "caseId": "hours",
      "difficulty": "subtle",
      "flaw": "Sunday instead of Saturday",
      "answer": "The store is open from 9am to 6pm, Monday to Sunday."
    }
  ]
}
```

Each one is graded by the judge with the context your app returned for its case. The report says how many were caught, split by difficulty. Obvious errors prove little; write subtle ones: one swapped detail in an almost-right answer.

## Blind review

```bash
npx noxeval review
```

One answer at a time: the question, what a correct answer looks like, and the answer. No verdict from the judge or the checks is shown, so your grading can't lean on them. Each distinct answer appears once, planted errors are mixed in unmarked, and the order is fixed per run. Quit with `q` and continue later.

At the end you get the judge's and the checks' agreement with you, the confusion matrix and **Cohen's kappa**: agreement minus what chance alone would give. With 24 correct answers out of 30, a judge that passes everything agrees 80% of the time and has a kappa of zero.

A review holds for one judge and one judge model. Change either, review again.

## Regression gate

"Does every case pass?" is the wrong question for a suite that changes every week: one known-flaky case fails every run, people learn to ignore the red, and a real regression slips through. A baseline asks **"did anything get worse than the last run we accepted?"**

```bash
npx noxeval run                       # some cases fail: known bugs
npx noxeval baseline update           # accept this run: writes noxeval-baseline.json
git add noxeval-baseline.json         # commit it, like a lockfile
npx noxeval run --baseline noxeval-baseline.json   # or baseline: "noxeval-baseline.json" in the config
```

With a baseline, the run exits with 1 only when something **regressed**:

| Case                                             | Result                                      |
| ------------------------------------------------ | ------------------------------------------- |
| passed in the baseline, fails now                | regressed                                   |
| failed and still fails                           | known failure: listed, doesn't fail the run |
| failed, now with a safety failure it didn't have | regressed                                   |
| new, and fails                                   | regressed (nobody accepted that failure)    |
| failed in the baseline, passes now               | fixed: accept it so it is guarded again     |

- `noxeval baseline update` is the only thing that writes the baseline. Runs never do: accepting a regression is always a reviewed change, committed with the change that caused it. It says what accepting changes, and refuses a partial (`--only`) run.
- The file keeps ids, verdicts, failure codes, pass rates and cost, never answers, sorted so an update is a small diff. It must live inside the project folder.
- The Markdown summary leads with "Compared with the baseline": regressed, fixed, known failures, flaky, new and removed cases.
- With cost reported, the change in cost per answer and in p95 latency is shown; a rise in cost per answer above `costWarnPercent` (config, default 20) is a warning, never a failure.

## In CI

`noxeval run` exits with 1 when a case fails (with a baseline: when something regressed) and appends a Markdown summary to the GitHub Actions job summary.

```yaml
- run: npx noxeval run --baseline noxeval-baseline.json --markdown noxeval-report.md
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
- uses: actions/upload-artifact@v7
  if: always()
  with:
    name: noxeval-report
    path: noxeval-report.*
```

## Programmatic use

```js
import { runEval, httpTarget, toMarkdown } from "noxeval";

const report = await runEval({ target: httpTarget({ url, answerPath: "answer" }), cases, checks: { allowedLinks: ["example.com"] } });
console.log(toMarkdown(report));
```

Everything the CLI uses is exported: `check`, `checkCitations`, `ungroundedDetails`, `checkLimits`, `compareReports`, `toBaseline`, `jsonlTarget`, `agreementStats`, `buildReview`, `summarizeReview`, `parseCaseFile` and the types.

## Roadmap

- `noxeval plant`: generate subtle planted errors from correct answers.
- JUnit XML report, for CI systems that read it.
- YAML case files.
- Judge adapter for the Anthropic API.
- More languages for the language check.
- Export a run as OpenTelemetry traces.

Ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Marcus Rodrigues
