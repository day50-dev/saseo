// The model client: plain replies, streaming, reasoning hidden, JSON asked for and repaired.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { chat, chatJson, chatStream } from "../../server/llm.ts";

const llm = await fakeLlm();
const ep = { baseUrl: `${llm.url}/v1`, model: "fake-model", apiKey: "k", timeoutSeconds: 10, protocol: "openai" as const };
after(() => llm.close());

describe("talking to the model", () => {
  test("a reply, without its <think> section", async () => {
    llm.on(/hello/, "<think>hmm</think> Hi there", 1);
    assert.equal(await chat(ep, [{ role: "user", content: "hello" }]), "Hi there");
  });

  test("not configured is said plainly", async () => {
    await assert.rejects(chat({ ...ep, baseUrl: "" }, []), /isn't configured/);
  });

  test("an HTTP error suggests /v1 when the base URL lacks it", async () => {
    await assert.rejects(chat({ ...ep, baseUrl: llm.url }, [{ role: "user", content: "x" }]), /try the base URL .*\/v1/);
  });

  test("JSON out of prose and code fences", async () => {
    llm.on(/give json/, 'Sure!\n```json\n{"a": 1}\n```', 1);
    assert.deepEqual(await chatJson(ep, [{ role: "user", content: "give json" }]), { a: 1 });
  });

  test("malformed JSON is asked for once more, with the reason", async () => {
    llm.on(/broken json/, '{"a": 1,}', 1);
    llm.on(/wasn't valid JSON/, '{"a": 2}', 1);
    assert.deepEqual(await chatJson(ep, [{ role: "user", content: "broken json" }]), { a: 2 });
  });

  test("and fails after the second try", async () => {
    llm.on(/never json|There was no JSON/, "no", 2);
    await assert.rejects(chatJson(ep, [{ role: "user", content: "never json" }]), /didn't return JSON/);
  });

  test("JSON is asked for in JSON mode, so a model can't answer in prose", async () => {
    llm.on(/json mode/, '{"ok": true}', 1);
    await chatJson(ep, [{ role: "user", content: "json mode" }]);
    assert.equal(llm.asked.at(-1)!.json, true);
  });

  test("an endpoint without JSON mode is asked again plainly, and remembered", async () => {
    const other = { ...ep, baseUrl: `${llm.url.replace("127.0.0.1", "localhost")}/v1` };
    llm.refuseJsonMode();
    llm.on(/plain please/, '{"ok": 1}', 2);
    assert.deepEqual(await chatJson(other, [{ role: "user", content: "plain please" }]), { ok: 1 });
    const n = llm.asked.length;
    assert.deepEqual(await chatJson(other, [{ role: "user", content: "plain please" }]), { ok: 1 });
    assert.equal(llm.asked.length, n + 1, "no second refused request");
    assert.equal(llm.asked.at(-1)!.json, false);
    llm.refuseJsonMode(false);
  });

  test("streaming, falling back to a plain reply when the server doesn't stream", async () => {
    llm.on(/stream me/, "<think>x</think>streamed", 1);
    const seen: string[] = [];
    assert.equal(await chatStream(ep, [{ role: "user", content: "stream me" }], (t) => seen.push(t)), "streamed");
    assert.deepEqual(seen, ["streamed"]);
  });

  test("streaming over server-sent events shows each piece, hiding an open <think>", async () => {
    const sse = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const d of ["<think>pl", "an</think>", "Hel", "lo"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((r) => sse.listen(0, "127.0.0.1", r));
    const seen: string[] = [];
    const out = await chatStream({ ...ep, baseUrl: `http://127.0.0.1:${(sse.address() as AddressInfo).port}` }, [], (t) => seen.push(t));
    sse.close();
    assert.equal(out, "Hello");
    assert.equal(seen[0], "");
    assert.equal(seen.at(-1), "Hello");
  });
});

// F-PROTOCOL: an endpoint set to Anthropic's protocol is spoken to with the Messages API.
describe("F-PROTOCOL: the Anthropic protocol", () => {
  const seen: { path: string; headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [{ type: "model", id: "claude-b", display_name: "B", created_at: "2026-01-01T00:00:00Z" }, { type: "model", id: "claude-a", display_name: "A", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: "claude-b", last_id: "claude-a" }));
      }
      const message = { id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } };
      if (body.stream) {
        res.setHeader("content-type", "text/event-stream");
        const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev("message_start", { message: { ...message, content: [], stop_reason: null } });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        for (const t of ["Hel", "lo ", "there"]) ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
        ev("message_stop", {});
        return res.end();
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...message, content: [{ type: "text", text: " Hi from Anthropic " }] }));
    });
  });
  const ready = new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  after(() => server.close());
  const aep = async () => {
    await ready;
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: "claude-test", apiKey: "sk-ant-test", timeoutSeconds: 10, protocol: "anthropic" as const };
  };

  test("a reply: the system prompt goes on its own, images as image blocks, the key from Settings", async () => {
    const reply = await chat(await aep(), [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] },
    ]);
    assert.equal(reply, "Hi from Anthropic");
    const req = seen.at(-1)!;
    assert.equal(req.path, "/v1/messages");
    assert.ok(req.headers["x-api-key"] === "sk-ant-test" || req.headers.authorization === "Bearer sk-ant-test", "the key from Settings is sent");
    assert.ok(req.headers["anthropic-version"]);
    assert.equal(req.body.system, "Be brief.");
    assert.equal(req.body.messages.length, 1);
    assert.deepEqual(req.body.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    assert.ok(req.body.max_tokens > 0);
  });

  test("streaming, and JSON asked for the same way", async () => {
    const parts: string[] = [];
    assert.equal(await chatStream(await aep(), [{ role: "user", content: "hi" }], (t) => parts.push(t)), "Hello there");
    assert.deepEqual(parts, ["Hel", "Hello ", "Hello there"]);
  });

  test("models are listed", async () => {
    const { listModels } = await import("../../server/providers.ts");
    assert.deepEqual(await listModels(await aep()), ["claude-a", "claude-b"]);
  });
});

describe("F-TTS: speaking through an OpenAI-compatible speech server", () => {
  test("POST /audio/speech with the model, voice and key from Settings", async () => {
    let got: { path?: string; auth?: string; body?: any } = {};
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        got = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
        res.setHeader("content-type", "audio/wav");
        res.end(Buffer.alloc(4000));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { speak, testTts } = await import("../../server/providers.ts");
    const tts = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "tts-key", model: "kokoro", voice: "af_heart" };
    assert.equal((await speak(tts, "Hello")).byteLength, 4000);
    assert.deepEqual(got, { path: "/v1/audio/speech", auth: "Bearer tts-key", body: { input: "Hello", response_format: "wav", model: "kokoro", voice: "af_heart" } });
    assert.equal((await testTts(tts)).ok, true);
    assert.equal((await testTts({ ...tts, baseUrl: "" })).ok, false);
    server.close();
  });
});
