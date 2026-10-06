export { defineConfig, loadConfig, resolveInputs, type NoxevalConfig } from "./config.ts";
export { runEval, type RunOptions } from "./app/run.ts";
export { toMarkdown } from "./app/markdown.ts";
export { httpTarget, functionTarget, type HttpTargetOptions } from "./adapters/http-target.ts";
export { jevJudge, DEFAULT_JEV_MODEL, type JevJudgeOptions } from "./adapters/jev-judge.ts";
export { openaiJudge, type OpenAIJudgeOptions } from "./adapters/openai-judge.ts";
export {
  check,
  contains,
  foreignLinks,
  languageOf,
  normalize,
  isRefusal,
  failureKind,
  type CheckOptions,
  type Failure,
  type FailureCode,
} from "./domain/checks.ts";
export { checkTrajectory, formatCall } from "./domain/trajectory.ts";
export { summarizeAttempts, wilsonLow, type Attempt, type AttemptsSummary } from "./domain/variance.ts";
export {
  canonicalNumber,
  extractDetails,
  groundedYears,
  indexContext,
  isGrounded,
  normalizeText,
  numberSet,
  splitSentences,
  ungroundedDetails,
  type ContextIndex,
  type Detail,
  type DetailKind,
  type DetailOptions,
  type GroundingOptions,
} from "./domain/grounding.ts";
export { asToolCall } from "./adapters/http-target.ts";
export { agreementStats, percentile, type AgreementStats, type Pair } from "./domain/agreement.ts";
export { decide, sureness, type Signals } from "./domain/verdict.ts";
export { buildReview, grade, summarizeReview, type ReviewFile, type ReviewItem } from "./domain/review.ts";
export {
  parseCaseFile,
  parsePlantedFile,
  hasTrajectoryChecks,
  CaseFileError,
  type CaseFile,
  type EvalCase,
  type PlantedError,
  type Difficulty,
  type Turn,
  type ToolCall,
  type Scalar,
} from "./domain/case.ts";
export type {
  Report,
  CaseResult,
  PlantedResult,
  JudgeSummary,
  PlantedSummary,
  HumanCheck,
  Tally,
  ToolsSummary,
  GroundingSummary,
} from "./domain/report.ts";
export type { Target, TargetResponse, Judge, JudgeInput, JudgeVerdict } from "./ports.ts";
export { VERSION } from "./version.ts";
