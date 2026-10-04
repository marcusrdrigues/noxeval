import { hasTrajectoryChecks, type EvalCase, type Scalar, type ToolCall } from "./case.ts";
import type { Failure } from "./checks.ts";

/**
 * Trajectory checks (0.3): the tool calls an agent made to answer. Deterministic, like the answer checks, and
 * written from three lessons of a real agent's first runs: require a tool only when the context can't answer,
 * check arguments only when the tool was called, and report a call that must never happen as its own failure.
 */

const norm = (v: unknown): string =>
  (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v)).trim().toLowerCase();

const matches = (call: ToolCall, want: Record<string, Scalar>): boolean =>
  Object.entries(want).every(([k, v]) => norm(call.args?.[k]) === norm(String(v)));

/** `name(key=value, ...)`, for reports and the terminal. Values longer than 40 characters are cut. */
export function formatCall(call: ToolCall): string {
  const args = Object.entries(call.args ?? {}).map(([k, v]) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
  });
  return `${call.name}(${args.join(", ")})`;
}

/**
 * Failures of one trajectory. `calls` undefined means the target didn't report one: a case with trajectory checks
 * then fails with `no-trajectory` instead of passing unverified. An empty array means "called nothing".
 */
export function checkTrajectory(c: EvalCase, calls: ToolCall[] | undefined): Failure[] {
  if (!hasTrajectoryChecks(c)) return [];
  if (calls === undefined)
    return [{ code: "no-trajectory", detail: "the target reported no toolCalls; return [] when no tool was called" }];
  const out: Failure[] = [];
  const names = calls.map((x) => x.name);
  const called = names.length ? ` (called ${[...new Set(names)].join(", ")})` : "";

  const expected = c.mustCallTool;
  if (expected && !names.some((n) => expected.includes(n)))
    out.push({ code: "tool-missing", detail: `expected ${expected.join(" or ")}${called}` });
  if (c.mustNotCallTools && calls.length > 0) out.push({ code: "tool-unexpected", detail: `expected no tool${called}` });
  for (const t of c.forbiddenTools ?? []) if (names.includes(t)) out.push({ code: "tool-forbidden", detail: t });
  const args = c.toolArgs;
  if (args && !calls.some((x) => matches(x, args)))
    out.push({
      code: "tool-args",
      detail: `no call with ${Object.entries(args)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    });
  for (const [tool, want] of Object.entries(c.toolArgsWhenCalled ?? {}))
    for (const x of calls.filter((y) => y.name === tool))
      if (!matches(x, want))
        out.push({
          code: "tool-args",
          detail: `${formatCall(x)}, expected ${Object.entries(want)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}`,
        });
  if (c.maxToolCalls !== undefined && calls.length > c.maxToolCalls)
    out.push({ code: "tool-limit", detail: `${calls.length} calls > ${c.maxToolCalls}` });
  return out;
}
