# Contributing

Thanks for helping. Issues, ideas and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/marcusrdrigues/noxeval && cd noxeval
npm install
npm run check   # typecheck, lint, format check and tests
```

Node.js 22.18 or later. Tests run TypeScript directly with `node --test` (Node strips the types), so there is no build step while you work. `npm run build` writes `dist/`, which is what npm publishes.

## How the code is organized

```
src/
  domain/     pure logic: cases, checks, citations, limits, verdict rule, agreement and kappa, report, baseline, blind review
  ports.ts    the two interfaces: Target and Judge
  adapters/   HTTP and JSONL targets, Jev judge, OpenAI-compatible judge
  app/        the run use case and the Markdown summary
  config.ts   loading noxeval.config.mjs and the files it points to
  cli/        init, run, review, baseline update
test/         one file per area; adapters are tested against local fake servers
examples/     a fake app to try the CLI end to end
```

Dependencies point inward: `domain` imports nothing outside itself, `adapters` and `app` depend on `domain` and `ports`, and only `cli` touches the terminal and the file system. See [docs/design.md](docs/design.md) for the decisions behind it.

## Rules of the house

- **No runtime dependencies.** Node 22 has `fetch`, `readline` and `parseArgs`; a new dependency needs a strong reason in the pull request.
- **Every behavior change comes with a test.** Network code is tested against a local server (`test/helpers.ts`), never a real API.
- **Never call a real model in tests**, and never commit API keys, `.env` files or real user data.
- **Pinned model ids** in defaults and docs, never `-latest` aliases.
- Code, comments, commits and docs in English. Comments explain why, not what.
- Formatting is Prettier's (`npm run format`); lint is ESLint with the strict TypeScript rules.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(checks): add Spanish to the language check`, `fix(review): keep notes on resume`, `docs: ...`, `test: ...`.

Before opening a pull request, run `npm run check`, add a line to `CHANGELOG.md` under the unreleased version, and describe what changed and how you tested it.

## Good first issues

- **JUnit XML report** (`--junit report.xml`), so Jenkins, GitLab and other CI systems show each case as a test.
- **YAML case files**, without adding a dependency (or with a very good reason).
- **Spanish** (and other languages) in the language check.
- **SSE target** for apps that stream with server-sent events.
- **Anthropic judge adapter**, following `openai-judge.ts`.
