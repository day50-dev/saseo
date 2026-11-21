// Thin clients for the configured LLM (OpenAI-compatible) and System One endpoints.
import type { Endpoint } from "./config.ts";

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

export async function chat(ep: Endpoint, messages: Message[], timeoutMs = ep.timeoutSeconds * 1000): Promise<string> {
  if (!ep.baseUrl || !ep.model) throw new Error("The language model isn't configured (Settings)");
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(ep),
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model: ep.model, messages, temperature: 0.3 }),
  });
  if (!res.ok) {
    const hint = res.status === 404 && !/\/v\d+$/.test(ep.baseUrl) ? ` (try the base URL ${ep.baseUrl}/v1 in Settings)` : "";
    throw new Error(`LLM: HTTP ${res.status}${hint} ${(await res.text()).slice(0, 300)}`.trim());
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("LLM: response had no message content");
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Text a reasoning model shows, without its <think> sections, including one still open. */
const visible = (text: string) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");

/**
 * Streams a reply, calling `onText` with everything visible so far as it arrives. Falls back to a
 * plain request if the endpoint doesn't stream. Resolves with the whole visible reply.
 */
export async function chatStream(ep: Endpoint, messages: Message[], onText: (soFar: string) => void): Promise<string> {
  if (!ep.baseUrl || !ep.model) throw new Error("The language model isn't configured (Settings)");
  const res = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(ep),
    signal: AbortSignal.timeout(ep.timeoutSeconds * 1000),
    body: JSON.stringify({ model: ep.model, messages, temperature: 0.3, stream: true }),
  });
  if (!res.ok) throw new Error(`LLM: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  if (!res.body || !(res.headers.get("content-type") ?? "").includes("event-stream")) {
    const data = await res.json();
    const text = visible(String(data?.choices?.[0]?.message?.content ?? "")).trim();
    onText(text);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
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
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          text += delta;
          onText(visible(text));
        }
      } catch {
        // A keep-alive or a partial line; the next read completes it.
      }
    }
  }
  return visible(text).trim();
}

/** Asks for JSON and parses the first object in the reply, tolerating code fences and prose around it. */
export async function chatJson<T>(ep: Endpoint, messages: Message[]): Promise<T> {
  const text = await chat(ep, messages);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`LLM didn't return JSON: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    throw new Error(`LLM returned malformed JSON: ${text.slice(start, start + 200)}`);
  }
}

/** One System One choice question; returns the chosen option and the model's confidence in it. */
export async function decideChoice(
  ep: Endpoint,
  state: unknown,
  instructions: string,
  criteria: Record<string, string>,
): Promise<{ choice: string; confidence: number }> {
  const res = await fetch(`${ep.baseUrl}/systemone`, {
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
  const res = await fetch(`${ep.baseUrl}/systemone`, {
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
