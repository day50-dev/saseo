// Thin clients for the configured LLM (OpenAI-compatible, or Anthropic's API: anthropic.ts) and System One endpoints.
import { anthropicChat, anthropicStream } from "./anthropic.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Endpoint } from "./config.ts";

/**
 * Counts the tokens every model call makes while a card's job runs, calls made side by side
 * included, so the card can show the whole job working, not just its longest write.
 */
interface Meter {
  done: number;
  flowing: Set<{ n: number }>;
  report: (tokens: number) => void;
}
const meter = new AsyncLocalStorage<Meter>();

/** Runs `job`, reporting the tokens all its model calls have received so far as they come. */
export function metered<T>(report: (tokens: number) => void, job: () => Promise<T>): Promise<T> {
  return meter.run({ done: 0, flowing: new Set(), report }, job);
}

function tally(m: Meter) {
  let n = m.done;
  for (const f of m.flowing) n += f.n;
  m.report(n);
}

/** Adds a finished reply to the job's count. */
function counted(tokens: number) {
  const m = meter.getStore();
  if (!m) return;
  m.done += tokens;
  tally(m);
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface Message {
  role: "system" | "user" | "assistant";
  content: string | Part[];
}

function headers(ep: Endpoint): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  return h;
}

/**
 * fetch, tried once more when the connection itself drops ("fetch failed": reset, refused, DNS).
 * Not on a timeout or an HTTP error: those are answers, and repeating them only adds waiting.
 */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return fetch(url, init);
  }
}

/** Endpoints that refused JSON mode (by base URL): asked plainly from then on. */
const noJsonMode = new Set<string>();

/**
 * One reply. `json` asks the endpoint for JSON mode (response_format), which keeps a model from
 * answering in prose (it may, given an image of math); an endpoint that refuses it is asked again
 * without, and remembered.
 */
export async function chat(ep: Endpoint, messages: Message[], timeoutMs = ep.timeoutSeconds * 1000, json = false): Promise<string> {
  if (!ep.baseUrl || !ep.model) throw new Error("The language model isn't configured (Settings)");
  if (ep.protocol === "anthropic") {
    const text = await anthropicChat(ep, messages, timeoutMs);
    counted(Math.round(text.length / 4));
    return text;
  }
  const jsonMode = json && !noJsonMode.has(ep.baseUrl);
  const res = await send(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(ep),
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model: ep.model, messages, temperature: 0.3, ...(jsonMode ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (jsonMode && (res.status === 400 || res.status === 422 || /response_format|json/i.test(body))) {
      noJsonMode.add(ep.baseUrl);
      return chat(ep, messages, timeoutMs, false);
    }
    const hint = res.status === 404 && !/\/v\d+$/.test(ep.baseUrl) ? ` (try the base URL ${ep.baseUrl}/v1 in Settings)` : "";
    throw new Error(`LLM: HTTP ${res.status}${hint} ${body.slice(0, 300)}`.trim());
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("LLM: response had no message content");
  counted(data?.usage?.completion_tokens ?? Math.round(text.length / 4));
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Text a reasoning model shows, without its <think> sections, including one still open. */
const visible = (text: string) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");

/**
 * Streams a reply, calling `onText` with everything visible so far as it arrives, and the tokens
 * received so far (thinking included: a reasoning model shows nothing for a while, but is working).
 * Falls back to a plain request if the endpoint doesn't stream. Resolves with the whole visible
 * reply. `json` asks for JSON mode, as `chat` does.
 */
export async function chatStream(ep: Endpoint, messages: Message[], onText: (soFar: string, tokens: number) => void, json = false): Promise<string> {
  const m = meter.getStore();
  if (!m) return streamOnce(ep, messages, onText, json);
  const mine = { n: 0 };
  m.flowing.add(mine);
  try {
    return await streamOnce(ep, messages, (soFar, tokens) => {
      mine.n = tokens;
      tally(m);
      onText(soFar, tokens);
    }, json);
  } finally {
    m.flowing.delete(mine);
    m.done += mine.n;
  }
}

async function streamOnce(ep: Endpoint, messages: Message[], onText: (soFar: string, tokens: number) => void, json: boolean): Promise<string> {
  if (!ep.baseUrl || !ep.model) throw new Error("The language model isn't configured (Settings)");
  if (ep.protocol === "anthropic") return anthropicStream(ep, messages, onText);
  const jsonMode = json && !noJsonMode.has(ep.baseUrl);
  const res = await send(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(ep),
    signal: AbortSignal.timeout(ep.timeoutSeconds * 1000),
    body: JSON.stringify({ model: ep.model, messages, temperature: 0.3, stream: true, ...(jsonMode ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (jsonMode && (res.status === 400 || res.status === 422 || /response_format|json/i.test(body))) {
      noJsonMode.add(ep.baseUrl);
      return streamOnce(ep, messages, onText, false);
    }
    throw new Error(`LLM: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("event-stream")) {
    const data = await res.json();
    const raw = String(data?.choices?.[0]?.message?.content ?? "");
    const text = visible(raw).trim();
    onText(text, data?.usage?.completion_tokens ?? Math.round(raw.length / 4));
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  // Servers send about a token per piece; reasoning arrives in its own field on some.
  let tokens = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, "").trim();
      if (!line.startsWith("data:") || !data || data === "[DONE]") continue;
      try {
        const d = JSON.parse(data)?.choices?.[0]?.delta;
        const delta = d?.content;
        const thought = d?.reasoning_content ?? d?.reasoning;
        if (typeof thought === "string" && thought) {
          tokens++;
          onText(visible(text), tokens);
        }
        if (typeof delta === "string" && delta) {
          text += delta;
          tokens++;
          onText(visible(text), tokens);
        }
      } catch {
        // A keep-alive or a partial line; the next read completes it.
      }
    }
  }
  return visible(text).trim();
}

// LaTeX commands that start with a letter JSON reads as an escape: "\\frac" would become a form feed
// and "rac", "\\nabla" a newline and "abla". Models often forget to double these backslashes.
const TEX_COMMANDS = new Set(
  ("beta bar bf big bigl bigr Big Bigl Bigr bigg binom bmod boldsymbol bot bowtie box bullet backslash " +
    "frac forall flat footnotesize frak frown " +
    "nabla neq nu ni notin not neg nearrow nexists natural nolimits nonumber " +
    "rho right rangle rightarrow Rightarrow rightleftharpoons rm rceil rfloor rvert rVert restriction " +
    "tau theta times text textbf textit textrm texttt tilde to top triangle triangleq tfrac therefore tiny Theta").split(" "),
);

/** Doubles backslashes that begin a LaTeX command rather than a JSON escape. */
export function repairTexEscapes(json: string): string {
  return json.replace(/\\\\|\\([a-zA-Z]+)|\\(?=[^"\\/bfnrtu])/g, (m, word: string | undefined) => {
    if (m === "\\") return "\\\\"; // a lone backslash before a character JSON can't escape: \( \[ \, \{
    if (!word) return m; // an already doubled backslash
    if (!"bfnrtu".includes(word[0]) || TEX_COMMANDS.has(word)) return `\\${m}`;
    return m;
  });
}

/** Asks for JSON and parses the first object in the reply, tolerating code fences and prose around it. */
/**
 * `onTokens`, when given, streams the first try and reports the tokens received as they come. So
 * does a call inside a card's job (`metered`), which the card shows.
 */
export async function chatJson<T>(ep: Endpoint, messages: Message[], onTokens?: (tokens: number) => void): Promise<T> {
  let text =
    onTokens || meter.getStore() ? await chatStream(ep, messages, (_t, n) => onTokens?.(n), true) : await chat(ep, messages, undefined, true);
  // A reply that won't parse gets one more try, told why (a long reply sometimes slips).
  for (let attempt = 0; ; attempt++) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    let problem: string;
    if (start < 0 || end <= start) problem = "There was no JSON object in it.";
    else {
      try {
        return JSON.parse(repairTexEscapes(text.slice(start, end + 1))) as T;
      } catch (err) {
        problem = `It wasn't valid JSON: ${err instanceof Error ? err.message : err}.`;
        console.warn("malformed JSON from the LLM:", problem, "\n", text.slice(start, end + 1));
      }
    }
    if (attempt >= 1) throw new Error(start < 0 || end <= start ? `LLM didn't return JSON: ${text.slice(0, 200)}` : `LLM returned malformed JSON: ${text.slice(start, start + 200)}`);
    text = await chat(ep, [
      ...messages,
      { role: "assistant", content: text },
      { role: "user", content: `That reply couldn't be used: ${problem} Give your answer to my request again, in exactly the JSON shape the instructions ask for, as one JSON object: double quotes, no comments, no trailing commas, plain numbers.` },
    ], undefined, true);
  }
}

/** One System One choice question; returns the chosen option and the model's confidence in it. */
export async function decideChoice(
  ep: Endpoint,
  state: unknown,
  instructions: string,
  criteria: Record<string, string>,
): Promise<{ choice: string; confidence: number }> {
  const res = await send(`${ep.baseUrl}/systemone`, {
    method: "POST",
    headers: headers(ep),
    signal: AbortSignal.timeout(ep.timeoutSeconds * 1000),
    body: JSON.stringify({ model: ep.model, state, questions: { q: { type: "choice", instructions, criteria } } }),
  });
  if (!res.ok) throw new Error(`System One: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const a = (await res.json())?.answers?.q;
  if (typeof a?.choice !== "string") throw new Error("System One: no choice in response");
  return { choice: a.choice, confidence: typeof a.confidence === "number" ? a.confidence : 0 };
}

export const systemOneConfigured = (ep: Endpoint) => Boolean(ep.baseUrl && ep.model);

/** One yes/no System One question; returns the probability of yes. */
export async function decideYesNo(ep: Endpoint, state: unknown, instructions: string): Promise<number> {
  const res = await send(`${ep.baseUrl}/systemone`, {
    method: "POST",
    headers: headers(ep),
    signal: AbortSignal.timeout(ep.timeoutSeconds * 1000),
    body: JSON.stringify({ model: ep.model, state, questions: { q: { type: "noul", instructions } } }),
  });
  if (!res.ok) throw new Error(`System One: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const p = (await res.json())?.answers?.q?.noul;
  if (typeof p !== "number") throw new Error("System One: no answer in response");
  return p;
}
