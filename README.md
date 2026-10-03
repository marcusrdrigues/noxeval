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

It was built for [Nox](https://marcusrdrigues.com), the RAG chat on the author's portfolio, and extracted so any LLM app can use it.

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

| Field              | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `id`               | Unique and stable. Reports, planted errors and reviews refer to it.                         |
| `question`         | What is sent to your app.                                                                   |
| `locale`           | Language the answer must be in (`pt` and `en` are checked; others skip the language check). |
| `expect`           | A correct answer in plain words. Shown to the human reviewer.                               |
| `mustInclude`      | Every group must match one of its terms. Accent-, quote- and case-insensitive.              |
| `mustNotInclude`   | Terms that must not appear.                                                                 |
| `mustNotMatch`     | Regular expressions (case-insensitive) that must not match.                                 |
| `refusal`          | The app must refuse, matched against `refusalPatterns` for the case locale.                 |
| `history`          | Earlier turns (`{ role, content }`), for multi-turn attacks.                                |
| `category`, `tags` | Free labels, counted in the report. Tags work well for OWASP Top 10 for LLMs ids (`LLM01`). |

The file is validated before any call, and every problem is listed at once.

## Targets

- `httpTarget({ url, answerPath?, contextPath?, headers?, body?, timeoutMs? })` POSTs `{ question, locale, history }` (or your own `body(case)`) and reads the answer from a JSON path, or the whole body as text when `answerPath` is omitted. `contextPath` reads what the model received (strings, or objects with `text`), which the judge uses.
- `functionTarget(name, async (c) => ({ answer, context }))` for anything else: streaming responses, an SDK, a function call in-process.

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

## In CI

`noxeval run` exits with 1 when a case fails and appends a Markdown summary to the GitHub Actions job summary.

```yaml
- run: npx noxeval run --markdown noxeval-report.md
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

Everything the CLI uses is exported: `check`, `agreementStats`, `buildReview`, `summarizeReview`, `parseCaseFile` and the types.

## Roadmap

- `noxeval plant`: generate subtle planted errors from correct answers.
- JUnit XML report, for CI systems that read it.
- YAML case files.
- Judge adapter for the Anthropic API.
- More languages for the language check.

Ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Marcus Rodrigues
