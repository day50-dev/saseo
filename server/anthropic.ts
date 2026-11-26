// The Anthropic protocol (the Messages API), for a model endpoint set to it in Settings. Everything
// else speaks the OpenAI protocol (llm.ts); this turns the same messages into Anthropic's shape.
import Anthropic from "@anthropic-ai/sdk";
import type { Endpoint } from "./config.ts";
import type { Message } from "./llm.ts";

/** Room for a whole card's JSON or a diagram; streaming has room for more. */
const MAX_TOKENS = 16000;
const MAX_TOKENS_STREAMING = 32000;

/** A client for this endpoint. Settings' base URLs end in /v1, and the SDK adds that itself. */
function client(ep: Endpoint, timeoutMs = ep.timeoutSeconds * 1000) {
  // Only the key from Settings: never a credential from the server's environment or a login profile.
  return new Anthropic({
    apiKey: ep.apiKey || "none",
    authToken: null,
    baseURL: ep.baseUrl.replace(/\/v1\/?$/, ""),
    timeout: timeoutMs,
    maxRetries: 1,
  });
}

/** An image given as a data: URL or a link, as Anthropic takes it. */
function image(url: string): Anthropic.ImageBlockParam {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/s.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1] as "image/png", data: m[2] } };
  return { type: "image", source: { type: "url", url } };
}

/** System messages become the system prompt; the rest keep their order. */
function shape(messages: Message[]): { system: string | undefined; messages: Anthropic.MessageParam[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")));
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m): Anthropic.MessageParam => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? { type: "text" as const, text: p.text } : image(p.image_url.url))),
    }));
  return { system: system.length ? system.join("\n\n") : undefined, messages: rest };
}

function textOf(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") throw new Error("LLM: the model declined to answer");
  return message.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("")
    .trim();
}

/** Errors in the words the rest of the app uses ("LLM: HTTP 401 …"). */
function rethrow(err: unknown): never {
  if (err instanceof Anthropic.APIError && err.status) throw new Error(`LLM: HTTP ${err.status} ${err.message}`.slice(0, 400));
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const e = new Error("LLM: no answer before the timeout");
    e.name = "TimeoutError";
    throw e;
  }
  throw err;
}

export async function anthropicChat(ep: Endpoint, messages: Message[], timeoutMs?: number): Promise<string> {
  const { system, messages: msgs } = shape(messages);
  try {
    const res = await client(ep, timeoutMs).messages.create({ model: ep.model, max_tokens: MAX_TOKENS, ...(system ? { system } : {}), messages: msgs });
    return textOf(res);
  } catch (err) {
    rethrow(err);
  }
}

export async function anthropicStream(ep: Endpoint, messages: Message[], onText: (soFar: string) => void): Promise<string> {
  const { system, messages: msgs } = shape(messages);
  try {
    const stream = client(ep).messages.stream({ model: ep.model, max_tokens: MAX_TOKENS_STREAMING, ...(system ? { system } : {}), messages: msgs });
    let text = "";
    stream.on("text", (delta) => {
      text += delta;
      onText(text);
    });
    return textOf(await stream.finalMessage());
  } catch (err) {
    rethrow(err);
  }
}

export async function anthropicModels(ep: Endpoint): Promise<string[]> {
  const ids: string[] = [];
  try {
    for await (const m of client(ep, 15_000).models.list()) ids.push(m.id);
  } catch (err) {
    rethrow(err);
  }
  return ids.sort();
}
