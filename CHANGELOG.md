# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Citations by id: targets report `sources` (`{ id, text }[]`; `httpTarget({ sourcesPath })`) and cases check them with `mustCite` (groups, one id of each must be cited) and `mustNotCite`. Citing an id that is not among the sources fails with `citation-unknown` and citing a forbidden one with `citation-forbidden`, both safety failures; a missed group fails with `citation-missing`, and `mustCite` without reported sources with `no-sources`. `checks.citations.pattern` changes how ids are found (default `[id]`, Markdown links skipped); a case skips the check with `"citations": false`. Without `context`, the sources' texts are the context. `citations` per case in the report; `checkCitations`, `citedIds`, `citationsApply`, `hasCitationChecks`, `asSource` and `DEFAULT_CITATION_PATTERN` exported.
- Baseline and regression: `noxeval run --baseline <file>` (or `baseline` in the config) compares the run with an accepted one and exits 1 only when something regressed: a case that passed and fails now, a new safety failure code on a known failure, or a new case that fails. Known failures don't fail the run but stay listed; fixed, flaky, new and removed cases are listed too, with a note when a fixed case still needs accepting. `noxeval baseline update [--from <report>] [--baseline <file>]` is the only thing that writes the baseline, says what accepting changes, and refuses a partial (`--only`) run. The baseline file keeps ids, verdicts, failure codes and pass rates, never answers; its paths (`--baseline`, `--from`, `baseline` in the config) must be inside the folder noxeval runs in, and `update` never overwrites a file that is not a baseline. "Compared with the baseline" in the Markdown summary and the terminal; `baseline` and `partial` in the report; `compareReports`, `toBaseline` and `parseBaseline` exported.

## [0.5.0] - 2026-10-06

### Added

- Ungrounded details: `checks.grounding` (`"off"`, `"report"` or `"check"`) and `--grounding`. Every number, acronym and proper name of an answer must be in the context the target returned. `report` measures; `check` fails the case with `ungrounded`, a usefulness failure. `checks.groundingAllow` lists names the answer may always say; a case skips the check with `"grounding": false`.
- The rules learned on Nox: number spellings ("10 mil", "10.000", "dez mil"), identifiers that aren't numbers, the question's bait passing only in a denial, and date arithmetic in plain sight ("3 years later" between two grounded years).
- `grounding` per case and in the report (checked, not checked, answers with ungrounded details), a Markdown table and a terminal line.
- `extractDetails`, `ungroundedDetails`, `canonicalNumber`, `numberSet`, `splitSentences`, `isGrounded`, `indexContext` and `groundedYears` exported.

## [0.4.0] - 2026-10-04

### Added

- `repeat` (config, `RunOptions`) and `--repeat N`: each case is asked N times. Any safety failure in any attempt fails the case; usefulness failures are weighed against `minPassRate` (config or per case, default 1).
- Per case: `attempts`, `passRate`, `passRateLow` (95% Wilson lower bound) and `firstPassed`; per report: `repeat` and `flaky`.
- Flaky cases in the Markdown summary and the terminal (`4/5` next to the case).
- `summarizeAttempts` and `wilsonLow` exported.

### Changed

- With `repeat > 1`, `passed` and `failures` of a case cover all attempts; the judge, its agreement and the blind review use the first attempt (`firstPassed`). With `repeat` 1 nothing changes.

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
