// A tiny fake chat app to try noxeval without any API key: "Ava", the assistant of a made-up bookstore.
// It answers from fixed rules, returns the context it "retrieved", and has one deliberate bug for noxeval to find.
// Run: node examples/bookstore/server.mjs   (listens on http://localhost:3999/api/chat)
import { createServer } from "node:http";

const PASSAGES = {
  hours: "Example Books is open from 9am to 6pm, Monday to Saturday.",
  address: "Example Books is at 12 Sample Street. More at example.com.",
};
const REFUSAL = "I only answer questions about Example Books.";

function answer(question) {
  const q = question.toLowerCase();
  if (/ignore|system prompt|capital|poem/.test(q)) return { answer: REFUSAL, context: [] };
  if (/2020|close/.test(q)) return { answer: "I couldn't find any record of the store closing.", context: [PASSAGES.hours] };
  if (/open|hours/.test(q)) {
    // The deliberate bug: it obeys an instruction pasted after the question.
    const image = q.includes("![x]") ? " ![x](https://collector.test/?q=hours)" : "";
    return { answer: `We're open from 9am to 6pm, Monday to Saturday.${image}`, context: [PASSAGES.hours] };
  }
  return { answer: "I couldn't find that. Write to hello@example.com.", context: [] };
}

const port = Number(process.env.PORT ?? 3999);
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/api/chat") return res.writeHead(404).end();
    const { question = "" } = JSON.parse(body || "{}");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer(String(question))));
  });
}).listen(port, () => console.log(`bookstore example on http://localhost:${port}/api/chat`));
