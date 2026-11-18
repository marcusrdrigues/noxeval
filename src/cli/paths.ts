import { access, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

/**
 * A path inside the project folder (where noxeval runs), resolved. A flag taken from the command line goes straight
 * to readFile/writeFile, and noxeval is often run by coding agents: an agent misled into passing `--out ~/.bashrc`
 * must not be able to make a run overwrite it. Paths that resolve outside the folder are refused; `sub/../file` that
 * ends up inside is fine. The baseline paths follow the same rule since 0.6.
 */
export function insideProject(path: string, flag: string, root = process.cwd()): string {
  const base = resolve(root);
  const full = resolve(base, path);
  // Windows compares paths case-insensitively: the same folder spelled with another case is still inside.
  const inside = process.platform === "win32" ? full.toLowerCase().startsWith(base.toLowerCase() + sep) : full.startsWith(base + sep);
  if (!inside) throw new Error(`${flag} must be a file inside ${base}: ${path}`);
  return full;
}

/**
 * The path a flag points at: inside the project, or anywhere when the user opted out with `--allow-outside` (a CI
 * layout that writes to ../artifacts). The opt-out skips only the folder check: a file that exists and is not
 * noxeval's is still never overwritten (guardNoxevalFile).
 */
export function targetPath(path: string, flag: string, allowOutside: boolean, root = process.cwd()): string {
  return allowOutside ? resolve(root, path) : insideProject(path, flag, root);
}

export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const asRecord = (raw: unknown) => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {});

/** The files noxeval writes are recognizable, so it never replaces anyone else's file. */
export const isNoxevalReport = (raw: unknown): boolean =>
  asRecord(asRecord(raw).tool).name === "noxeval" && Array.isArray(asRecord(raw).cases);
export const isReviewFile = (raw: unknown): boolean => Array.isArray(asRecord(raw).items) && typeof asRecord(raw).runAt === "string";
/** Every Markdown summary opens with "## noxeval: ". */
export const isNoxevalSummary = (text: string): boolean => /^## noxeval: /m.test(text);

/**
 * Refuses to overwrite a file noxeval did not write: the report, the Markdown summary and the review file are the
 * only files a run or a review may replace. Applies with `--allow-outside` too, so the opt-out can't turn into
 * "clobber anything outside". A file that can't be read or parsed counts as not noxeval's: the person running it
 * decides what to do with it.
 */
export async function guardNoxevalFile(path: string, shown: string, kind: "report" | "summary" | "review"): Promise<void> {
  if (!(await exists(path))) return;
  let noxevals: boolean;
  try {
    if (kind === "summary") noxevals = isNoxevalSummary(await readFile(path, "utf8"));
    else {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      noxevals = kind === "report" ? isNoxevalReport(raw) : isReviewFile(raw);
    }
  } catch {
    noxevals = false;
  }
  if (!noxevals) throw new Error(`${shown} exists and is not a noxeval ${kind} file: move it, or choose another path`);
}
