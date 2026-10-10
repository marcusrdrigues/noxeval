# Design notes

Why noxeval works the way it does. Each decision lists what was discarded and why.

## Checks before the judge

Deterministic checks run on every case and decide pass or fail. The judge never changes the score: it gives a second verdict and points at disagreements. A check is reproducible and explains itself ("missing: Java | Kotlin"); a judge is neither. The judge earns its place on what rules can't express (an unsupported fact, a false denial, an accepted false premise), and the disagreement list is where a human should look first.

_Discarded:_ judge-only scoring. Cheaper to write, but the number moves between runs and a failure says nothing actionable.

## One verdict rule for every judge

`domain/verdict.ts` turns signals into pass or fail the same way for Jev (probabilities) and LLM judges (booleans). Judges can then be compared on equal terms, and a new adapter only has to produce signals.

The questions are atomic and get the minimum state each one needs. Refusal and leak look at the answer alone: with the user question in the state, a question asking for the system prompt made one-line refusals look like leaks. The user question is passed as untrusted data, because a judge reads attacker-controlled text too and needs the same injection defenses as the app it grades.

## Planted errors

All-correct samples are common (a mature app passes its own cases) and they only measure whether the judge passes what is right. Planted errors are wrong answers tied to real cases and graded with that case's context, so the judge sees exactly what it would see for a real answer. `difficulty` separates obvious errors (prove little) from subtle ones (one swapped detail).

_Discarded:_ generating planted errors with an LLM in v0.1. Useful later (`noxeval plant`), but hand-written errors are the ones you can be sure are wrong.

## Blind review

The reviewer never sees the judge's or the checks' verdict while grading (anchoring bias), and the review file only receives those verdicts after each grade, so opening the file mid-review doesn't spoil it. Identical answers appear once (twenty identical refusals are one item), and the order is a seeded shuffle of the run time: stable across sittings, different across runs.

Agreement is reported with Cohen's kappa, because raw agreement flatters a judge that passes everything when most answers are correct. Kappa is `null` when both raters always give the same verdict: honest "not applicable" instead of a misleading number.

_Discarded:_ random sampling of N answers. Distinct answers of a typical suite are few enough to grade all of them in about ten minutes, and sampling would skip exactly the odd case.

## Pinned models

The Jev default is a versioned id (`jev-1.13.0`) and `openaiJudge` requires a model. An alias moves on its own and silently shifts verdicts and calibrated thresholds; changing a model should be a reviewed change, followed by a new run and a new blind review.

## Trajectory checks (0.3)

Agents are graded on the answer and on the tool calls behind it. The checks are deterministic, like the answer checks, and came from the first agent graded with noxeval: a case may require a tool only when the context can't answer; arguments of a whole-document lookup are checked only if the lookup happened (`toolArgsWhenCalled`); a call that must never happen (`forbiddenTools`) and a runaway loop (`maxToolCalls`) are safety failures, apart from a missing call.

A missing `toolCalls` field fails a case that has trajectory checks (`no-trajectory`); an empty array passes as "called nothing". Treating both the same would let a target that forgot to report its calls score green.

_Discarded:_ an exact ordered `toolSequence`. Valid trajectories vary (list then open, or open directly), and an exact sequence fails correct runs. Also discarded: grading the trajectory with an LLM judge, for the same reason checks come before the judge everywhere else.

## Variance (0.4)

Asked once, a case is a coin flip read as a verdict. With `repeat`, the rule mirrors `failureKind`: safety has zero tolerance (one leak in N attempts fails the case), usefulness has a threshold (`minPassRate`). The report gives the 95% Wilson lower bound next to the rate, because 5 of 5 and 500 of 500 are not the same evidence.

The judge grades the first attempt only, and the blind review shows only that answer: both exist to check the checks, not to measure variance, and grading every attempt would multiply cost by N. The judge's agreement is computed against the first attempt's verdict (`firstPassed`), which is the answer it saw.

_Discarded:_ pass@k (passes if any attempt passes). It fits code generation, where the best of k is kept; a chat user sees one answer.

## Regression gate (0.6)

A suite that changes every week can't be graded by "does every case pass?": one known failure keeps it red, and red that is always there stops being read. The baseline answers "did anything get worse than the last run we accepted?", and it is a committed file that only `noxeval baseline update` writes, so accepting a regression is a reviewed change, like a lockfile.

The gate compares failure codes, not details: an invented source `[x]` becoming `[y]` is the same failure, while a known usefulness failure that gains a safety code got worse. The judge and planted errors stay out of it, for the same reason the judge never decides a case: it checks the checks.

Citations, cost and latency follow the rule of the other checks: the target reports what happened (source ids, `costUsd`, its own time) and noxeval never guesses. What can't be checked is listed as not checked (`no-sources`, cost limits without a cost, a recorded line without `ms`), never passed.

_Discarded:_ checking that a cited passage supports its sentence (meaning, the judge's job); estimating cost from token counts and a price table (prices change, and the app knows its own bill); comparing total cost against the baseline (adding cases would read as a dearer app).

## No runtime dependencies

Node 22 has `fetch`, `readline`, `util.parseArgs` and type stripping. Fewer dependencies means a smaller supply-chain surface (OWASP LLM04) for a tool that handles API keys.

_Discarded:_ zod for validation. The case format is small, and hand-written validation lists every problem in plain words.

## Layers

`domain` (pure, no I/O) ← `ports` (Target, Judge) ← `adapters` and `app` ← `cli`. The CLI is the only place that touches the terminal and the file system, so the same run can be driven from code (`runEval`) or from CI.
