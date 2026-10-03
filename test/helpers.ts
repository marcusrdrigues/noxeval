import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = { url: string; headers: IncomingMessage["headers"]; body: unknown };

/** A local HTTP server for adapter tests. Records every request it gets. */
export async function fakeServer(handler: (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(body, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const json = (res: ServerResponse, value: unknown, status = 200) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
