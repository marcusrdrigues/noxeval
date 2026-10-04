# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-03

### Added

- Trajectory checks for agents: `mustCallTool`, `mustNotCallTools`, `forbiddenTools`, `toolArgs`, `toolArgsWhenCalled` and `maxToolCalls` in the case file, with the failure codes `tool-missing`, `tool-unexpected`, `tool-forbidden`, `tool-args` and `tool-limit`.
- `no-trajectory`: a case with trajectory checks fails when the target reports no `toolCalls`, instead of passing unverified.
- `TargetResponse.toolCalls` and `httpTarget({ toolCallsPath })`, reading `{ name, args }`, `{ name, arguments }` and the OpenAI `{ function: { name, arguments } }` shape.
- `failureKind(code)`: "safety" or "usefulness".
- Tool calls in the report (`tools` summary, `toolCalls` per case), the Markdown summary and the terminal.
- `checkTrajectory`, `formatCall`, `asToolCall` and `hasTrajectoryChecks` exported for programmatic use.

## [0.2.0] - 2026-10-03

### Added

- A terminal look for `run` and `review`: the NOX wordmark, live progress, case lines with the reason under each failure, and a summary box with bars for the score, the judge and the planted errors. Color only on an interactive terminal; plain text in CI, in logs, with `NO_COLOR` or `TERM=dumb` (`FORCE_COLOR` turns it on).

## [0.1.0] - 2026-10-03

### Added

- Case files with validation that lists every problem at once.
- Deterministic checks: required and forbidden terms, forbidden patterns, refusals, answer language (pt, en), links outside an allow list, Markdown images, prompt-leak markers, length.
- Targets: `httpTarget` and `functionTarget`.
- Judges: `jevJudge` (pinned to `jev-1.13.0`) and `openaiJudge` for OpenAI-compatible APIs.
- Planted errors with difficulty (`obvious`, `subtle`).
- Blind review in the terminal, with agreement, confusion matrix and Cohen's kappa for the judge and the checks.
- JSON report, Markdown summary, GitHub Actions job summary and exit codes for CI.
- `noxeval init`, `noxeval run`, `noxeval review`.
