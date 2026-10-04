/**
 * Terminal look of the CLI: colors, the NOX wordmark, case lines, bars and boxes. No dependencies, only ANSI codes.
 *
 * Color is used only on an interactive terminal. In CI, in a log file, with NO_COLOR or TERM=dumb, every function
 * returns plain text: escape codes in a log are noise. FORCE_COLOR turns color on anyway.
 */

export type Env = Record<string, string | undefined>;

/** https://no-color.org and the FORCE_COLOR convention. */
export function colorEnabled(env: Env, isTTY: boolean): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb" || env.CI) return false;
  return isTTY;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");
/** Width as the terminal shows it (no escape codes; the box and block characters used here are one column wide). */
export const visibleWidth = (s: string): number => [...stripAnsi(s)].length;

/** Breaks text into lines of at most `width` columns, on spaces. A longer word gets a line of its own. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A bar of `size` cells for `part` of `whole`. */
export function bar(part: number, whole: number, size = 20): { full: string; empty: string } {
  const filled = whole > 0 ? Math.round((part / whole) * size) : 0;
  return { full: "█".repeat(filled), empty: "░".repeat(size - filled) };
}

const WORDMARK = [
  ["█▄ █ █▀█ ▀▄▀", "█▀▀ █ █ ▄▀█ █  "],
  ["█ ▀█ █▄█ █ █", "██▄ ▀▄▀ █▀█ █▄▄"],
];

export function createUi(options: { color: boolean; columns?: number }) {
  const { color } = options;
  const width = Math.max(40, Math.min(options.columns ?? 80, 76));
  const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const c = {
    purple: paint("38;2;139;108;255"),
    gold: paint("38;2;201;162;39"),
    green: paint("32"),
    red: paint("31"),
    dim: paint("2"),
    bold: paint("1"),
  };
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleWidth(s)));

  /** A box around lines, with an optional title on the top edge. Every row is `width` columns wide. */
  function box(lines: string[], title = ""): string {
    const inner = width - 4;
    const label = title ? ` ${c.bold(title)} ` : "";
    const top = c.purple("╭─") + label + c.purple(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(label)))}╮`);
    const body = lines.map((l) => `${c.purple("│")} ${pad(l, inner)} ${c.purple("│")}`);
    return [top, ...body, c.purple(`╰${"─".repeat(width - 2)}╯`)].join("\n");
  }

  return {
    color,
    width,
    c,
    pad,
    box,
    /** The NOX wordmark and the version, only on a color terminal. Plain output keeps a one-line header. */
    banner(version: string, tagline: string): string {
      if (!color) return `noxeval ${version}`;
      const rows = WORDMARK.map(([nox, evalWord]) => `  ${c.purple(nox ?? "")} ${evalWord ?? ""}`);
      return ["", ...rows, `  ${c.dim(`v${version} · ${tagline}`)}`, ""].join("\n");
    },
    /** One finished case: mark, id, time, judge verdict and, when it failed, why. */
    caseLine(r: {
      id: string;
      passed: boolean;
      ms: number | null;
      judge?: { pass: boolean } | null;
      judgeError?: string;
      failures: string[];
      /** Tool calls already formatted (0.3), shown under the case line. */
      tools?: string[];
    }): string {
      const mark = r.passed ? c.green("✓") : c.red("✗");
      const time = r.ms === null ? "" : c.dim(`${r.ms} ms`);
      const judged = r.judge ? `judge ${r.judge.pass ? c.green("✓") : c.red("✗")}` : r.judgeError ? c.gold("judge error") : "";
      const head = `  ${mark} ${pad(r.passed ? r.id : c.bold(r.id), 28)} ${pad(time, 9)} ${judged}`.trimEnd();
      const tools = r.tools?.length ? [c.dim(`    tools: ${r.tools.join(" → ")}`)] : [];
      const why = r.failures.map((f, i) => c.dim(`    ${i === r.failures.length - 1 ? "└" : "├"} ${f}`));
      return [head, ...tools, ...why].join("\n");
    },
    /** "label  ██████░░░░  4/5  80%" for the summary box. */
    meter(label: string, part: number, whole: number, note = ""): string {
      const b = bar(part, whole, 14);
      const pct = whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-";
      const tone = part === whole ? c.green : c.gold;
      return `${pad(label, 9)} ${tone(b.full)}${c.dim(b.empty)}  ${part}/${whole}  ${c.dim(pct)}${note ? `  ${c.dim(note)}` : ""}`;
    },
    /** A titled block for the blind review: the label in purple, the text wrapped to the box width. */
    card(label: string, text: string): string {
      return [c.purple(label), ...wrap(text, width - 4).map((l) => `  ${l}`)].join("\n");
    },
  };
}

export type Ui = ReturnType<typeof createUi>;

/** Spinner on one line, redrawn in place. Does nothing without color (no live redraws in logs). */
export function spinner(ui: Ui, write: (s: string) => void) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let text = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  const draw = () => write(`\r\x1b[2K  ${ui.c.purple(frames[i++ % frames.length] ?? "")} ${ui.c.dim(text)}`);
  return {
    update(next: string) {
      if (!ui.color) return;
      text = next;
      if (!timer) timer = setInterval(draw, 80);
      draw();
    },
    /** Clears the line, so the next printed line takes its place. */
    clear() {
      if (!ui.color) return;
      if (timer) clearInterval(timer);
      timer = null;
      write("\r\x1b[2K");
    },
  };
}
