// F-ASK (a card's conversation), F-FIG (figures it makes, and redoing them), F-CALL (a call's turns
// over HTTP) and F-SPEECH (the server's voice and ears), through the real server and a fake model.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, objectCard, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CardItem, CanvasState } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url, { LIBRARIAN_TTS_URL: llm.url, LIBRARIAN_STT_URL: llm.url });
let s: TestServer;

before(async () => {
  seed(env.LIBRARIAN_DATA, [
    {
      id: "talk0001",
      name: "Talk",
      items: [
        explained("eig", "Eigenvectors", 0, 0, { h: 400 }),
        objectCard("g1", { type: "graph", title: "K4", nodes: [{ id: "a", label: "A" }], edges: [] }, 0, 3000, { h: 300 }),
        objectCard("g2", { type: "graph", title: "Petersen", nodes: [{ id: "a", label: "A" }], edges: [] }, 0, 4000, { h: 300 }),
      ],
    },
  ]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});
beforeEach(() => llm.reset());

const items = async () => ((await s.api("GET", "/api/canvases/talk0001")).body as CanvasState).items.filter((i): i is CardItem => i.kind === "card");
const card = async (id: string) => (await items()).find((c) => c.id === id)!;
const chat = (id: string, text: string) => s.api("POST", `/api/canvases/talk0001/cards/${id}/chat`, { text });
const settled = (id: string) => until(async () => ((await card(id))?.chatPending === false ? card(id) : null), 15000, "the answer");
const made = (id: string) => until(async () => {
  const c = await card(id);
  return c && (c.stage === "done" || c.stage === "failed") ? c : null;
}, 15000, "the object card");

describe("F-ASK: ask about anything, right where it is", () => {
  test("a question is answered on the card, with what the card knows", async () => {
    llm.on(/conversation box on a card/, { kind: "answer", request: "what is it" });
    llm.on(/talking with a curious/, "It's a direction a matrix only stretches [1].");
    assert.equal((await chat("eig", "What is an eigenvector, really?")).status, 200);
    const c = await settled("eig");
    assert.deepEqual(c.chat!.map((m) => [m.role, m.text]), [
      ["user", "What is an eigenvector, really?"],
      ["assistant", "It's a direction a matrix only stretches [1]."],
    ]);
    const asked = llm.askedFor(/talking with a curious/)[0];
    assert.match(asked.system, /Eigenvectors in one line/, "the card's explanation went with it");
  });

  test("an empty message, or one while it's still answering, is refused", async () => {
    assert.equal((await chat("eig", "  ")).status, 400);
    llm.on(/conversation box on a card/, { kind: "answer", request: "x" });
    llm.on(/talking with a curious/, () => new Promise((r) => setTimeout(() => r("Slowly."), 1500)));
    assert.equal((await chat("eig", "first")).status, 200);
    assert.equal((await chat("eig", "second")).status, 409);
    await settled("eig");
  });

  test("a model failure is said on the card, not swallowed", async () => {
    llm.on(/conversation box on a card/, { kind: "answer", request: "x" });
    // No rule for the answer: the fake model errors.
    await chat("eig", "Why does it matter?");
    const c = await settled("eig");
    assert.match(c.chat!.at(-1)!.text, /Couldn't answer/);
  });
});

describe("F-FIG: figures made from a card's conversation", () => {
  let plotId = "";

  test("asking to plot makes a plot card beside it, linked from the conversation", async () => {
    llm.on(/conversation box on a card/, { kind: "plot", request: "sin x and cos x" });
    llm.on(/You plot mathematics/, { title: "Sine and cosine", x: { min: 0, max: 6.3 }, y: {}, series: [{ label: "sin", fn: "sin(x)" }, { label: "cos", fn: "cos(x)" }] });
    await chat("eig", "Can you plot sin x and cos x?");
    const c = await settled("eig");
    const note = c.chat!.at(-1)!;
    assert.equal(note.text, "Plotting: sin x and cos x");
    plotId = note.objectId!;
    const p = await made(plotId);
    assert.equal(p.stage, "done");
    assert.equal(p.parentId, "eig");
    assert.ok(p.x >= 720, "beside, not on, the card it came from");
    assert.equal(p.object!.type, "plot");
    assert.equal(p.subject, "Sine and cosine");
  });

  test("asking the plot card for a change redoes it in place, given the plot it had", async () => {
    llm.on(/holds something found or made/, { change: true, request: "sin x and cos x, from -10 to 10" });
    llm.on(/You plot mathematics/, { title: "Wider", x: { min: -10, max: 10 }, y: {}, series: [{ fn: "sin(x)" }] });
    await chat(plotId, "show it from -10 to 10");
    const p = await until(async () => ((await card(plotId)).subject === "Wider" ? card(plotId) : null), 15000, "the redo");
    assert.equal(p.chat!.at(-1)!.text, "Plotting it again: sin x and cos x, from -10 to 10");
    assert.equal(p.replaced!.subject, "Sine and cosine");
    assert.match(llm.askedFor(/You plot mathematics/)[0].user, /The plot they had[\s\S]*Sine and cosine/);
  });

  test("the earlier one can be brought back, and swapped again", async () => {
    assert.equal((await s.api("POST", `/api/canvases/talk0001/cards/${plotId}/object/back`)).status, 200);
    assert.equal((await card(plotId)).subject, "Sine and cosine");
    await s.api("POST", `/api/canvases/talk0001/cards/${plotId}/object/back`);
    assert.equal((await card(plotId)).subject, "Wider");
    assert.equal((await s.api("POST", "/api/canvases/talk0001/cards/eig/object/back")).status, 409);
  });

  test("a question about what the card holds is answered, not redone", async () => {
    llm.on(/holds something found or made/, { change: false, request: "" });
    llm.on(/conversation box on a card/, { kind: "answer", request: "x" });
    llm.on(/talking with a curious/, "Where they cross, sin x equals cos x.");
    await chat(plotId, "where do they cross?");
    const p = await settled(plotId);
    assert.equal(p.subject, "Wider");
    assert.equal(p.chat!.at(-1)!.text, "Where they cross, sin x equals cos x.");
  });

  test("a graph and a table, each its own kind of card", async () => {
    llm.on(/conversation box on a card/, (a) => (/graph/.test(a.user) ? { kind: "graph", request: "a tree" } : { kind: "table", request: "eigenvalues of small matrices" }));
    llm.on(/You draw a graph/, { title: "A tree", directed: true, nodes: [{ id: "r", label: "root" }, { id: "c", label: "child" }], edges: [{ from: "r", to: "c" }] });
    llm.on(/web search query/, { query: "eigenvalues" });
    llm.on(/You make a table of data/, { title: "Eigenvalues", columns: ["matrix", "λ"], rows: [["I", 1]], sources: [] });
    await chat("eig", "draw me a graph of it");
    const g = await made((await settled("eig")).chat!.at(-1)!.objectId!);
    assert.equal(g.object!.type, "graph");
    await chat("eig", "a table of eigenvalues please");
    const t = await made((await settled("eig")).chat!.at(-1)!.objectId!);
    assert.equal(t.object!.type, "table");
    assert.equal((t.object as { fromMemory?: boolean }).fromMemory, true);
  });

  test("a figure that can't be made says why on its card", async () => {
    llm.on(/conversation box on a card/, { kind: "plot", request: "nonsense" });
    llm.on(/You plot mathematics/, { title: "x", series: [{ fn: "rm -rf" }] });
    await chat("eig", "plot nonsense");
    const p = await made((await settled("eig")).chat!.at(-1)!.objectId!);
    assert.equal(p.stage, "failed");
    assert.match(p.error!, /Couldn't read the math/);
  });
});

describe("F-CALL over HTTP", () => {
  const call = (body: object) => s.api("POST", "/api/canvases/talk0001/call", body);

  test("noise gets no answer and costs nothing", async () => {
    assert.deepEqual((await call({ text: "um" })).body, { say: "" });
    assert.equal(llm.asked.length, 0);
    assert.equal((await call({ text: " " })).status, 400);
  });

  test("a picked number is answered even when it's a stray-sounding word", async () => {
    llm.on(/voice call/, { say: "That one.", actions: [] });
    assert.equal((await call({ text: "uh", context: { picked: 1, marks: [{ n: 1, cardId: "g1", label: "K4" }] } })).body.say, "That one.");
  });

  test("removing on a call hides the cards; showing undoes it", async () => {
    llm.on(/voice call/, { say: "I'll take it off.", actions: [{ kind: "remove", ids: ["g2"] }] });
    const r = (await call({ text: "get rid of the Petersen graph" })).body;
    assert.deepEqual(r.removed, ["g2"]);
    assert.equal((await card("g2")).hidden, true);
    await s.api("POST", "/api/canvases/talk0001/show", { ids: r.removed });
    assert.equal((await card("g2")).hidden, false);
  });

  test("finding on a call puts a new card beside what they point at", async () => {
    llm.on(/voice call/, { say: "Plotting it.", actions: [{ kind: "find", find: "plot", request: "x squared" }] });
    llm.on(/You plot mathematics/, { title: "x squared", series: [{ fn: "x^2" }] });
    const r = (await call({ text: "can you plot x squared", pointing: { cardId: "eig" } })).body;
    const id = r.did.match(/\((\w+)\)$/)[1];
    const p = await made(id);
    assert.equal(p.parentId, "eig");
    assert.equal(p.object!.type, "plot");
  });

  test("a failed turn is said briefly", async () => {
    // No rule: the fake model errors.
    assert.match((await call({ text: "what is this thing" })).body.say, /lost that one/);
  });
});

describe("F-SPEECH: the server's voice and ears", () => {
  test("/api/me says both are there", async () => {
    assert.deepEqual((await s.api("GET", "/api/me")).body.speech, { tts: true, stt: true });
  });

  test("words in, speech out", async () => {
    const r = await fetch(`${s.url}/api/speech/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hello there" }) });
    assert.equal(r.headers.get("content-type"), "audio/wav");
    assert.equal(llm.spoken.at(-1), "Hello there");
    assert.equal((await s.api("POST", "/api/speech/say", { text: "" })).status, 400);
  });

  test("speech in, words out, primed with the canvas's subjects", async () => {
    llm.hears("why do eigenvectors matter");
    const r = await fetch(`${s.url}/api/speech/listen?cid=talk0001`, { method: "POST", body: Buffer.from("wav bytes") });
    assert.deepEqual(await r.json(), { text: "why do eigenvectors matter" });
    assert.equal(llm.heard.at(-1)!.toString(), "wav bytes");
  });

  test("what a recogniser invents from room noise is dropped", async () => {
    for (const noise of ["Thank you.", "you", "[Music]", "..."]) {
      llm.hears(noise);
      const r = await fetch(`${s.url}/api/speech/listen`, { method: "POST", body: Buffer.from("x") });
      assert.deepEqual(await r.json(), { text: "" }, noise);
    }
  });
});
