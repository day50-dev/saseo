// F-CALL: one turn of a call. These check what the model is shown (little, unless it asks) and what
// Librarian does with its answer. Whether a real model chooses well is in test/live.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, useEnv } from "../helpers/env.ts";
import type { CardItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
useEnv(testEnv(llm.url));
const C = await import("../../server/canvas.ts");
const { callTurn, deixis, describePointing, cardContent, besideOf } = await import("../../server/call.ts");
after(() => llm.close());

const sem = { title: "Eigenvector", why: ["Matrices stretch space"], what: { gist: "A direction that only stretches", details: ["Its stretch is the eigenvalue"] }, parts: [{ symbol: "λ", meaning: "how much" }], here: ["Used on the slide"], name: "", terms: [] };
const cards: CardItem[] = [
  { kind: "card", id: "eig", parentId: "", x: 0, y: 0, w: 720, h: 600, stage: "done", subject: "Eigenvector", sem: sem as never },
  { kind: "card", id: "map1", parentId: "eig", x: 800, y: 0, w: 720, h: 500, stage: "done", subject: "Lagrange's life", objectKind: "map", object: { type: "map", title: "Lagrange", places: [{ name: "Turin", lat: 45, lon: 7, note: "born" }, { name: "Berlin", lat: 52, lon: 13 }], route: true } },
  { kind: "card", id: "g1", parentId: "eig", x: 800, y: 600, w: 720, h: 500, stage: "done", subject: "K4", objectKind: "graph", object: { type: "graph", title: "K4", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] } },
  { kind: "card", id: "g2", parentId: "eig", x: 800, y: 1200, w: 720, h: 500, stage: "done", subject: "Petersen", objectKind: "graph", object: { type: "graph", title: "P", nodes: [], edges: [] } },
];

let store: InstanceType<typeof C.CanvasStore>;
const did: string[] = [];
const hooks = {
  grow: async (c: CardItem, ext: { shape: string; at: string }) => void did.push(`grow ${c.id} ${ext.shape} ${ext.at}`),
  descend: async (c: CardItem, phrase: string) => (did.push(`descend ${c.id} ${phrase}`), cards[0]),
  find: async (near: CardItem | undefined, kind: string, request: string, focus?: string) => (did.push(`find ${near?.id} ${kind} ${request}${focus ? ` @${focus}` : ""}`), cards[0]),
  remove: async (ids: string[]) => (did.push(`remove ${ids.join(",")}`), ids),
};
const turn = (text: string, pointing = {}, ctx = {}, history: { role: "you" | "librarian"; text: string }[] = []) => callTurn(store, text, pointing, history, hooks as never, ctx);
/** The glance the model got first. */
const glance = () => llm.askedFor(/research librarian on a voice call/)[0].user;

before(async () => {
  const info = await C.createCanvas("call");
  store = (await C.canvasStore(info.id))!;
  for (const c of cards) await store.add(structuredClone(c));
  await C.addReaderNote(info.id, { q: "background?", a: "I studied physics", at: "" } as never);
});
beforeEach(() => {
  llm.reset();
  did.length = 0;
});

describe("F-CALL-1: the glance is small", () => {
  test("what they point at, what they said, who they are; not the whole canvas", async () => {
    llm.on(/voice call/, { say: "It's a direction that only stretches.", actions: [] });
    const r = await turn("what is this?", { cardId: "eig", key: "what-0", pieceText: "A direction that only stretches" });
    assert.equal(r.say, "It's a direction that only stretches.");
    const g = glance();
    assert.match(g, /Pointing at: "A direction that only stretches", on the card "Eigenvector"/);
    assert.match(g, /They just said: "what is this\?"/);
    assert.match(g, /About them: I studied physics/);
    assert.doesNotMatch(g, /Petersen|Lagrange|Turin/);
    assert.equal(llm.asked.length, 1, "no look-ups needed");
  });

  test("a selection wins over the pointer", async () => {
    llm.on(/voice call/, { say: "ok", actions: [] });
    await turn("what does this mean", { cardId: "eig", selection: "eigenvalue", selectionContext: "Its stretch is the eigenvalue" });
    assert.match(glance(), /They have SELECTED: "eigenvalue" \(in: "Its stretch is the eigenvalue"\), on "Eigenvector"/);
  });

  test("a figure part is named in the figure's terms", async () => {
    llm.on(/voice call/, { say: "ok", actions: [] });
    await turn("why here?", { cardId: "map1", figure: "place 2 of 2 on the map: Berlin" });
    assert.match(glance(), /Pointing at: place 2 of 2 on the map: Berlin, on "Lagrange's life" \(map card\)/);
  });

  test("not pointing at anything is said", async () => {
    llm.on(/voice call/, { say: "ok", actions: [] });
    await turn("hello there");
    assert.match(glance(), /Not pointing at anything/);
  });

  test("the call so far, the last eight turns", async () => {
    llm.on(/voice call/, { say: "ok", actions: [] });
    const history = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? "librarian" : "you") as "you" | "librarian", text: `turn ${i}` }));
    await turn("and then?", {}, {}, history);
    assert.match(glance(), /turn 11/);
    assert.doesNotMatch(glance(), /turn 3\b/);
  });
});

describe("F-CALL-2: \"this\" and \"that\" are what the pointer was on as each was said", () => {
  test("deixis follows the pointer through the sentence", () => {
    const ctx = { spoke: 4000, timeline: [{ at: 0, p: { cardId: "map1" } }, { at: 2500, p: { cardId: "g1" } }] };
    const d = deixis("compare this one with that one", ctx);
    assert.deepEqual(d.map((x) => [x.word, x.p.cardId]), [["this", "map1"], ["that", "g1"]]);
    assert.deepEqual(deixis("no pointing words", ctx), []);
    assert.deepEqual(deixis("this", {}), []);
  });

  test("both are in the glance, in order", async () => {
    llm.on(/voice call/, { say: "ok", actions: [] });
    await turn("compare this one with that one", {}, { spoke: 4000, timeline: [{ at: 0, p: { cardId: "map1" } }, { at: 2500, p: { cardId: "g1" } }] });
    assert.match(glance(), /As they spoke they pointed at, in order: "this" = the card "Lagrange's life" \(map card\); "that" = the card "K4" \(graph card\)/);
  });

  test("describePointing", () => {
    assert.equal(describePointing({ cardId: "nope" }, cards), "");
    assert.equal(describePointing({ cardId: "g1" }, cards), 'the card "K4" (graph card)');
  });
});

describe("F-CALL-3: look-ups, only when asked for", () => {
  test("cards, card, recent and goals; at most two rounds", async () => {
    llm.on(/voice call/, (a) => (a.messages.length === 2 ? { look: [{ tool: "cards" }, { tool: "recent" }] } : undefined));
    llm.on(/voice call/, (a) => (a.messages.length === 4 ? { look: [{ tool: "card", id: "map1" }, { tool: "goals" }] } : undefined));
    // A third look-up isn't offered: it has to answer.
    llm.on(/voice call/, (a) => (a.messages.length === 6 ? { say: "Done looking." } : undefined));
    const r = await turn("the map from before", { cardId: "g1" }, { visible: ["g1", "map1"], recent: [{ ago: 5000, what: "looked at the map" }] });
    assert.deepEqual(r.looked, ["cards", "recent", "card(map1)", "goals"]);
    const answers = llm.askedFor(/voice call/).map((a) => a.user);
    assert.match(answers[1], /map1: map card, "Lagrange's life" \(on screen\)/);
    assert.match(answers[1], /g1: graph card, "K4" \(on screen\) \(pointed at\)/);
    assert.match(answers[1], /5s ago: looked at the map/);
    assert.match(answers[2], /1\. Turin \(born\); 2\. Berlin/);
    assert.match(answers[2], /No goals yet/);
    assert.match(answers[2], /no more look-ups/);
    assert.equal(r.say, "Done looking.");
  });

  test("a card's content lists its pieces by key", () => {
    const c = cardContent(cards[0]);
    for (const k of ["[why-0]", "[what-0] A direction", "[what-1]", "[part-0] λ = how much", "[here-0]"]) assert.ok(c.includes(k), k);
  });
});

describe("F-CALL-4: what it does on the canvas", () => {
  test("grow the piece pointed at; an unknown shape becomes an aside", async () => {
    llm.on(/voice call/, { say: "Let me break that down.", actions: [{ kind: "grow", shape: "parts" }, { kind: "grow", shape: "dance" }] });
    const r = await turn("break this down", { cardId: "eig", key: "what-0" });
    assert.deepEqual(did, ["grow eig parts what-0", "grow eig aside what-0"]);
    assert.match(r.did!, /grew parts on what-0/);
  });

  test("descend on the selection, else the phrase it names", async () => {
    llm.on(/voice call/, { say: "ok", actions: [{ kind: "descend", phrase: "stretch" }] });
    await turn("what does this word mean", { cardId: "eig", selection: "eigenvalue" });
    await turn("what's a stretch", { cardId: "eig" });
    assert.deepEqual(did, ["descend eig eigenvalue", "descend eig stretch"]);
  });

  test("find things beside what they point at, about the piece pointed at; an unknown kind is videos", async () => {
    llm.on(/voice call/, { say: "ok", actions: [{ kind: "find", find: "map", request: "Lagrange's travels" }, { kind: "find", find: "podcasts", request: "x" }] });
    await turn("map it", { cardId: "eig", key: "why-0", pieceText: "Matrices stretch space" });
    assert.deepEqual(did, ["find eig map Lagrange's travels @Matrices stretch space", "find eig videos x @Matrices stretch space"]);
  });

  test("with nothing pointed at, beside the newest card", async () => {
    llm.on(/voice call/, { say: "ok", actions: [{ kind: "find", find: "plot", request: "sin x" }] });
    await turn("plot sine");
    assert.deepEqual(did, ["find g2 plot sin x"]);
  });

  test("remove only cards that exist; a made-up id is admitted to", async () => {
    llm.on(/voice call/, { say: "Taking it off.", actions: [{ kind: "remove", ids: ["g1"] }] }, 1);
    const r = await turn("get rid of the K4 graph");
    assert.deepEqual(r.removed, ["g1"]);
    llm.on(/voice call/, { say: "Taking it off.", actions: [{ kind: "remove", ids: ["ghost"] }] }, 1);
    const r2 = await turn("get rid of the ghost");
    assert.equal(r2.removed, undefined);
    assert.match(r2.say, /didn't work/);
  });

  test("at most three actions", async () => {
    llm.on(/voice call/, { say: "ok", actions: Array(5).fill({ kind: "grow", shape: "why" }) });
    await turn("more more more", { cardId: "eig", key: "what-0" });
    assert.equal(did.length, 3);
  });

  test("plain words instead of JSON are spoken; JSON-looking junk is not", async () => {
    llm.on(/voice call/, "It means a direction that only stretches.", 1);
    assert.equal((await turn("what is it")).say, "It means a direction that only stretches.");
    llm.on(/voice call/, "{not json", 1);
    assert.match((await turn("what is it")).say, /didn't catch that/);
  });
});

describe("F-CALL-5: when it could be more than one thing, it numbers them and asks", () => {
  test("marks are numbered, only on cards that exist, at most five", async () => {
    llm.on(/voice call/, { say: "Which one? I've numbered them.", actions: [{ kind: "mark", marks: [{ card: "g1", label: "K4" }, { card: "ghost", label: "?" }, { card: "g2", piece: "what-0", label: "Petersen" }] }] });
    const r = await turn("get rid of the graph");
    assert.deepEqual(r.marks, [{ n: 1, cardId: "g1", label: "K4" }, { n: 2, cardId: "g2", key: "what-0", label: "Petersen" }]);
    assert.deepEqual(did, [], "nothing removed while asking");
  });

  test("the marks still showing are in the next glance", async () => {
    llm.on(/voice call/, { say: "ok", actions: [] });
    await turn("hmm, the first", {}, { marks: [{ n: 1, cardId: "g1", label: "K4" }, { n: 2, cardId: "g2", label: "Petersen" }] });
    assert.match(glance(), /Numbered on screen from your last turn: 1 = K4; 2 = Petersen/);
  });

  test("a pick is the answer to its question, and points at the picked card", async () => {
    llm.on(/voice call/, (a) => (a.messages.length === 2 ? { look: [{ tool: "cards" }] } : { say: "Removing it.", actions: [{ kind: "remove", ids: ["g2"] }] }));
    const history = [{ role: "you" as const, text: "get rid of the other graph" }, { role: "librarian" as const, text: "Which one? I've numbered them." }];
    const r = await turn("two", {}, { picked: 2, marks: [{ n: 1, cardId: "g1", label: "K4" }, { n: 2, cardId: "g2", label: "Petersen" }] }, history);
    assert.match(glance(), /They picked number 2: the card "Petersen" \(graph card\) \(card id g2\)\. That is the thing their earlier request was about/);
    assert.doesNotMatch(glance(), /Numbered on screen from your last turn/);
    assert.match(llm.askedFor(/voice call/)[1].user, /g2: graph card, "Petersen" \(the one they picked\)/);
    assert.deepEqual(r.removed, ["g2"]);
  });
});

describe("F-CALL-6: where a card opened from a call goes", () => {
  test("to the right of its card, below anything already there", () => {
    const from = cards[0];
    const at = besideOf(cards, from, (c) => c.h ?? 300);
    assert.equal(at.x, from.x + from.w + 64);
    assert.ok(at.y >= 1200 + 500 + 24, `y ${at.y} below the column`);
  });
});
