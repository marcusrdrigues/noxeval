/** fetch with a timeout and a readable error. The response body of a failed call is trimmed, never logged whole. */
export class HttpError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(`HTTP ${res.status} from ${new URL(url).host}${text ? `: ${text.slice(0, 200)}` : ""}`, res.status);
    }
    return res;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      controller.signal.aborted ? `timeout after ${timeoutMs} ms (${new URL(url).host})` : `network error (${new URL(url).host})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a dot path ("data.answer", "choices.0.text") from parsed JSON. */
export function pick(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
