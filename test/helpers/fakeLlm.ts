// A stand-in for the language model and the speech servers: an OpenAI-compatible endpoint that
// answers from rules the test sets ("when the system prompt says X, reply Y") and records every
// request, so tests can check both what Librarian does with an answer and what it asked.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface Asked {
  /** The system prompt. */
  system: string;
  /** The last user message, as text. */
  user: string;
  messages: { role: string; content: unknown }[];
  stream: boolean;
  /** Asked for JSON mode (response_format). */
  json: boolean;
}

type Reply = string | object | ((a: Asked) => string | object | undefined | Promise<string | object | undefined>);

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n")
      : "";

const body = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

export async function fakeLlm() {
  const rules: { match: RegExp; reply: Reply; times: number }[] = [];
  const asked: Asked[] = [];
  const heard: Buffer[] = [];
  const spoken: string[] = [];
  let transcript = "what is an eigenvector";
  let refuseJson = false;
  // The decision model (System One): answers a yes/no question about a state.
  let decide: ((state: Record<string, unknown>, instructions: string) => number) | null = null;
  const decided: Record<string, unknown>[] = [];
  // A stand-in Wikipedia: article summaries by title, and what a search finds.
  const wiki = new Map<string, object>();
  const wikiSearch = new Map<string, string>();

  const server = createServer(async (req, res) => {
    const raw = await body(req);
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.url === "/v1/models") return json(200, { data: [{ id: "fake-model" }] });
    if (req.url === "/transcribe") {
      heard.push(raw);
      return json(200, { text: transcript });
    }
    if (req.url === "/v1/audio/speech") {
      spoken.push(String(JSON.parse(raw.toString() || "{}").input ?? ""));
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(Buffer.from("RIFF0000WAVEfake"));
    }
    if (req.url?.startsWith("/api/rest_v1/page/summary/")) {
      const title = decodeURIComponent(req.url.slice("/api/rest_v1/page/summary/".length)).replace(/_/g, " ");
      const page = wiki.get(title);
      return page ? json(200, page) : json(404, { type: "https://mediawiki.org/wiki/HyperSwitch/errors/not_found" });
    }
    if (req.url?.startsWith("/w/api.php")) {
      const q = new URL(req.url, "http://x").searchParams.get("srsearch") ?? "";
      const hit = [...wikiSearch].find(([k]) => q.toLowerCase().includes(k.toLowerCase()))?.[1];
      return json(200, { query: { search: hit ? [{ title: hit }] : [] } });
    }
    if (req.url === "/v1/systemone") {
      const b = JSON.parse(raw.toString());
      decided.push(b.state);
      if (!decide) return json(500, { error: "fake decision model has no rule" });
      return json(200, { answers: { q: { noul: decide(b.state, b.questions.q.instructions) } } });
    }
    if (req.url !== "/v1/chat/completions") return json(404, { error: "not here" });
    const b = JSON.parse(raw.toString());
    const messages = b.messages as Asked["messages"];
    const a: Asked = {
      system: text(messages.find((m) => m.role === "system")?.content),
      user: text([...messages].reverse().find((m) => m.role === "user")?.content),
      messages,
      stream: Boolean(b.stream),
      json: b.response_format?.type === "json_object",
    };
    if (a.json && refuseJson) return json(400, { error: "response_format is not supported" });
    asked.push(a);
    const hay = `${a.system}\n${a.user}`;
    for (const r of rules) {
      if (r.times === 0 || !r.match.test(hay)) continue;
      const out = typeof r.reply === "function" ? await r.reply(a) : r.reply;
      if (out === undefined) continue;
      if (r.times > 0) r.times--;
      const content = typeof out === "string" ? out : JSON.stringify(out);
      return json(200, { choices: [{ message: { role: "assistant", content } }] });
    }
    json(500, { error: `fake model has no rule for: ${a.system.slice(0, 80)} / ${a.user.slice(0, 80)}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    asked,
    heard,
    spoken,
    /** Answer requests matching `match` (system prompt + last user message) with `reply`; newest rules win. */
    on(match: RegExp, reply: Reply, times = -1) {
      rules.unshift({ match, reply, times });
    },
    /** Answer requests for JSON mode with a 400, as servers without it do. */
    refuseJsonMode(on = true) {
      refuseJson = on;
    },
    /** What the speech recogniser hears next. */
    hears(words: string) {
      transcript = words;
    },
    reset() {
      rules.length = 0;
      asked.length = 0;
      decide = null;
      decided.length = 0;
    },
    /** Adds an article to the stand-in Wikipedia; `found by` words that search finds it with. */
    wikiPage(title: string, page: object, foundBy?: string) {
      wiki.set(title, { type: "standard", title, ...page });
      if (foundBy) wikiSearch.set(foundBy, title);
    },
    /** Answers the decision model's yes/no questions: the probability of yes, from the state. */
    onDecide(fn: (state: Record<string, unknown>, instructions: string) => number) {
      decide = fn;
    },
    /** States the decision model was asked about. */
    decided,
    /** Requests whose system prompt or user message matches. */
    askedFor(match: RegExp) {
      return asked.filter((a) => match.test(`${a.system}\n${a.user}`));
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type FakeLlm = Awaited<ReturnType<typeof fakeLlm>>;
