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
