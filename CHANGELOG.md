# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

### Added

- Case files with validation that lists every problem at once.
- Deterministic checks: required and forbidden terms, forbidden patterns, refusals, answer language (pt, en), links outside an allow list, Markdown images, prompt-leak markers, length.
- Targets: `httpTarget` and `functionTarget`.
- Judges: `jevJudge` (pinned to `jev-1.13.0`) and `openaiJudge` for OpenAI-compatible APIs.
- Planted errors with difficulty (`obvious`, `subtle`).
- Blind review in the terminal, with agreement, confusion matrix and Cohen's kappa for the judge and the checks.
- JSON report, Markdown summary, GitHub Actions job summary and exit codes for CI.
- `noxeval init`, `noxeval run`, `noxeval review`.
