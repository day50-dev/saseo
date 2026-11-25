// The model client: plain replies, streaming, reasoning hidden, JSON asked for and repaired.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { chat, chatJson, chatStream } from "../../server/llm.ts";

const llm = await fakeLlm();
const ep = { baseUrl: `${llm.url}/v1`, model: "fake-model", apiKey: "k", timeoutSeconds: 10 };
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
