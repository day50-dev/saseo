// F-NOTES: free-form notes, left by you or the librarian, each with its context (who, when, about
// what, after what) and a history to look into. Through the real server and a fake model.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem, NoteHistory, NoteItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url, { LIBRARIAN_TTS_URL: llm.url, LIBRARIAN_STT_URL: llm.url });
let s: TestServer;
const C = "/api/canvases/note0001";

before(async () => {
  seed(env.LIBRARIAN_DATA, [{ id: "note0001", name: "Notes", items: [explained("eig", "Eigenvectors", 0, 0, { h: 400, w: 720 }), explained("det", "Determinants", 0, 2000, { h: 400 })] }]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});
beforeEach(() => llm.reset());

const state = async () => (await s.api("GET", C)).body as CanvasState;
const notes = async () => (await state()).items.filter((i): i is NoteItem => i.kind === "note" && !i.hidden);
const history = async (id: string) => (await s.api("GET", `${C}/notes/${id}/history`)).body as NoteHistory;

describe("F-NOTES: notes you leave", () => {
  test("a loose note keeps its words, place, author, time and the moment it was left", async () => {
    const before = (await state()).seq;
    const r = await s.api("POST", `${C}/notes`, { text: "  Check this against\nthe textbook  ", x: 100, y: 900 });
    assert.equal(r.status, 200);
    const n = r.body.note as NoteItem;
    assert.equal(n.text, "Check this against\nthe textbook");
    assert.deepEqual([n.x, n.y, n.by, n.on, n.context.via, n.context.seq], [100, 900, "you", undefined, "canvas", before]);
    assert.ok(Math.abs(Date.parse(n.at) - Date.now()) < 10_000);
    assert.ok((await notes()).some((x) => x.id === n.id));
  });

  test("an empty note is refused", async () => {
    assert.equal((await s.api("POST", `${C}/notes`, { text: "   " })).status, 400);
  });

  test("a note about a card lands beside it, and a second one below the first", async () => {
    const a = (await s.api("POST", `${C}/notes`, { text: "First thought", on: { id: "eig", key: "what-0", quote: "Eigenvectors in one line" } })).body.note as NoteItem;
    assert.deepEqual(a.on, { id: "eig", key: "what-0", quote: "Eigenvectors in one line" });
    assert.ok(a.x >= 720, `beside the card, not on it: x=${a.x}`);
    const b = (await s.api("POST", `${C}/notes`, { text: "Second thought", on: { id: "eig" } })).body.note as NoteItem;
    assert.equal(b.x, a.x);
    assert.ok(b.y > a.y, "below the first");
  });

  test("rewording keeps every earlier wording, with who and when", async () => {
    const n = (await s.api("POST", `${C}/notes`, { text: "v1", x: 0, y: 5000 })).body.note as NoteItem;
    await s.api("PATCH", `${C}/notes/${n.id}`, { text: "v2" });
    const r = await s.api("PATCH", `${C}/notes/${n.id}`, { text: "v3" });
    const now = r.body.note as NoteItem;
    assert.equal(now.text, "v3");
    assert.deepEqual(now.was!.map((w) => [w.text, w.by]), [["v1", "you"], ["v2", "you"]]);
    assert.equal(now.edited?.by, "you");
    const h = await history(n.id);
    assert.deepEqual(h.versions.map((v) => v.text), ["v1", "v2", "v3"]);
    assert.ok(h.since.some((e) => /reworded/.test(e.what)), JSON.stringify(h.since));
    assert.equal((await s.api("PATCH", `${C}/notes/${n.id}`, { text: "" })).status, 400);
    assert.equal((await s.api("PATCH", `${C}/notes/nope`, { text: "x" })).status, 404);
  });

  test("its history says what happened on the canvas before it was left, and not after", async () => {
    llm.on(/conversation box on a card/, { kind: "answer", request: "why" });
    llm.on(/talking with a curious/, "Because the matrix only stretches it.");
    await s.api("POST", `${C}/cards/det/chat`, { text: "Why is the determinant a product?" });
    await until(async () => ((await state()).items.find((i) => i.id === "det") as CardItem).chatPending === false, 10_000, "the answer");
    const n = (await s.api("POST", `${C}/notes`, { text: "Come back to products", on: { id: "det" } })).body.note as NoteItem;
    await s.api("POST", `${C}/cards/det/chat`, { text: "And the sign?" });
    const h = await history(n.id);
    assert.ok(h.before.some((e) => e.what.includes("Why is the determinant a product?") && e.id === "det"), JSON.stringify(h.before));
    assert.ok(!h.before.some((e) => e.what.includes("And the sign?")), "nothing after it is in 'before'");
    assert.ok(h.since.some((e) => e.what.includes("And the sign?")), "what happened to its card since is");
    assert.equal((await s.api("GET", `${C}/notes/eig/history`)).status, 404, "a card has no note history");
  });

  test("a note goes with what it's about: removed with it, and back with it", async () => {
    const n = (await s.api("POST", `${C}/notes`, { text: "About det", on: { id: "det" } })).body.note as NoteItem;
    const hidden = (await s.api("POST", `${C}/hide`, { ids: ["det"] })).body.ids as string[];
    assert.ok(hidden.includes(n.id));
    await s.api("POST", `${C}/show`, { ids: hidden });
    assert.ok((await notes()).some((x) => x.id === n.id));
  });

  test("a note moves and resizes like anything else", async () => {
    const n = (await s.api("POST", `${C}/notes`, { text: "Move me", x: 0, y: 7000 })).body.note as NoteItem;
    assert.equal((await s.api("POST", `${C}/move`, { moves: [{ id: n.id, x: 50, y: 7100, w: 400 }] })).status, 200);
    const now = (await notes()).find((x) => x.id === n.id)!;
    assert.deepEqual([now.x, now.y, now.w], [50, 7100, 400]);
  });
});

describe("F-NOTES: notes the librarian leaves", () => {
  test("on a call, it leaves a note about what you point at, remembering what you said", async () => {
    llm.on(/voice call/, { say: "Noted.", actions: [{ kind: "note", text: "The 1 is the unit of the algebra." }] });
    const said = "note that the one is the unit";
    const r = await s.api("POST", `${C}/call`, { text: said, pointing: { cardId: "eig", key: "why-0", pieceText: "A first reason" } });
    assert.match(r.body.did, /left a note/);
    const n = (await notes()).find((x) => x.text === "The 1 is the unit of the algebra.")!;
    assert.ok(n, "the note is on the canvas");
    assert.deepEqual([n.by, n.context.via, n.context.said, n.on?.id, n.on?.key, n.on?.quote], ["librarian", "call", said, "eig", "why-0", "A first reason"]);
    assert.match(llm.askedFor(/voice call/)[0].system, /"kind": "note"/, "the call knows it can leave notes");
  });

  test("on a call with nothing pointed at, the note is loose", async () => {
    llm.on(/voice call/, { say: "Got it.", actions: [{ kind: "note", text: "Ask about Hopf algebras next" }] });
    await s.api("POST", `${C}/call`, { text: "remind me to ask about Hopf algebras", pointing: {} });
    const n = (await notes()).find((x) => x.text === "Ask about Hopf algebras next")!;
    assert.equal(n.on, undefined);
  });

  test("asking a card to note something leaves a note beside it, not an answer", async () => {
    llm.on(/conversation box on a card/, { kind: "note", request: "Check the 2x2 case by hand" });
    await s.api("POST", `${C}/cards/eig/chat`, { text: "note: check the 2x2 case by hand" });
    const card = await until(async () => {
      const c = (await state()).items.find((i) => i.id === "eig") as CardItem;
      return c.chatPending === false && c.chat?.at(-1)?.role === "assistant" ? c : null;
    }, 10_000, "the reply");
    const n = (await notes()).find((x) => x.text === "Check the 2x2 case by hand")!;
    assert.deepEqual([n.by, n.context.via, n.on?.id], ["librarian", "chat", "eig"]);
    assert.equal(card.chat!.at(-1)!.objectId, n.id);
    assert.equal(llm.askedFor(/talking with a curious/).length, 0, "nothing was answered");
  });

  test("on a call, it reads a note you select words in or point at", async () => {
    const n = (await s.api("POST", `${C}/notes`, { text: "Bogomol'nyi–Prasad–Sommerfield bound", x: 3000, y: 0 })).body.note as NoteItem;
    llm.on(/voice call/, { say: "It's a lower bound on a soliton's energy.", actions: [] });
    await s.api("POST", `${C}/call`, { text: "can you see my note", pointing: { cardId: n.id, selection: "Prasad–Sommerfield", pieceText: n.text } });
    let asked = llm.askedFor(/voice call/).at(-1)!;
    assert.match(asked.user, /SELECTED: "Prasad–Sommerfield".*in their note, which says "Bogomol'nyi–Prasad–Sommerfield bound"/);
    await s.api("POST", `${C}/call`, { text: "what is this about", pointing: { cardId: n.id, pieceText: n.text } });
    asked = llm.askedFor(/voice call/).at(-1)!;
    assert.match(asked.user, /Pointing at: their note, which says "Bogomol'nyi–Prasad–Sommerfield bound"/);
  });

  test("on a call, notes can be looked up: listed with the cards, and read by id", async () => {
    const n = (await s.api("POST", `${C}/notes`, { text: "Read Manton–Sutcliffe chapter 4", x: 3000, y: 400 })).body.note as NoteItem;
    let round = 0;
    llm.on(/voice call/, () => (round++ === 0 ? { look: [{ tool: "cards" }, { tool: "card", id: n.id }] } : { say: "Your note says to read chapter 4.", actions: [] }));
    const r = await s.api("POST", `${C}/call`, { text: "what did I write in my note about the book" });
    assert.equal(r.body.say, "Your note says to read chapter 4.");
    const answers = llm.askedFor(/voice call/).at(-1)!.user;
    assert.match(answers, new RegExp(`${n.id}: note by them, "Read Manton–Sutcliffe chapter 4"`));
    assert.match(answers, /a note they wrote, at .*It says: "Read Manton–Sutcliffe chapter 4"/);
  });
});
