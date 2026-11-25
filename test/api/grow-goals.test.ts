// F-GROW (growing a shape from any piece) and F-GOALS (what you're after, as a tree), through the
// real server and a fake model.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CardItem, CanvasState, Extension, Goal } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
before(async () => {
  seed(env.LIBRARIAN_DATA, [{ id: "grow0001", name: "Grow", items: [explained("eig", "Eigenvectors", 0, 0, { h: 500 })] }]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});
beforeEach(() => llm.reset());

const view = async () => (await s.api("GET", "/api/canvases/grow0001")).body as CanvasState;
const card = async (id: string) => (await view()).items.find((i) => i.id === id) as CardItem;
const grow = (body: object) => s.api("POST", "/api/canvases/grow0001/cards/eig/extend", body);
const grown = (id: string) =>
  until(async () => {
    const e = (await card("eig")).ext?.find((x) => x.id === id);
    return e && e.status !== "working" ? e : null;
  }, 15000, "the shape to grow");

describe("F-GROW: grow the diagram from any piece", () => {
  test("a picked shape grows from the piece, told what that piece says", async () => {
    llm.on(/asked for more right there/, { items: ["First you find the matrix", "Then you solve for λ", "Then the arrows"], label: "3 steps" });
    const { ext } = (await grow({ at: "what-0", shape: "steps" })).body as { ext: Extension };
    const e = await grown(ext.id);
    assert.deepEqual([e.status, e.shape, e.items!.length, e.label], ["done", "steps", 3, "3 steps"]);
    assert.match(llm.askedFor(/asked for more right there/)[0].user, /The piece they pointed at[^\n]*:\nEigenvectors in one line/);
  });

  test("a break-down has parts and what they add up to; a fork needs two ways", async () => {
    llm.on(/asked for more right there/, (a) => (/Parts/i.test(a.user) && /break/i.test(a.user) ? { parts: [{ name: "direction", note: "where it points" }, { name: "stretch", note: "how far" }], together: "an eigenvector" } : { branches: [{ label: "one way", items: ["a"] }] }));
    const parts = await grown(((await grow({ at: "why-0", shape: "parts" })).body as { ext: Extension }).ext.id);
    assert.deepEqual(parts.parts!.map((p) => p.name), ["direction", "stretch"]);
    assert.equal(parts.together, "an eigenvector");
    const split = await grown(((await grow({ at: "why-0", shape: "split" })).body as { ext: Extension }).ext.id);
    assert.equal(split.status, "failed");
    assert.match(split.error!, /didn't split into two/);
  });

  test("what grows has its own pieces, which grow in turn, and go with it when it's taken away", async () => {
    llm.on(/asked for more right there/, { items: ["a deeper line"] });
    const first = await grown(((await grow({ at: "what-0", shape: "aside" })).body as { ext: Extension }).ext.id);
    const second = await grown(((await grow({ at: `x${first.id}.0`, shape: "why" })).body as { ext: Extension }).ext.id);
    assert.match(llm.askedFor(/asked for more right there/).at(-1)!.user, /Eigenvectors in one line\n  → a deeper line/);
    const r = (await s.api("POST", `/api/canvases/grow0001/cards/eig/extend/${first.id}/remove`)).body;
    assert.deepEqual(r.removed.sort(), [first.id, second.id].sort());
    assert.ok(!(await card("eig")).ext!.some((e) => e.id === first.id || e.id === second.id));
    // Undo puts them back.
    await s.api("POST", "/api/canvases/grow0001/cards/eig/extend/restore", { ext: r.taken });
    assert.ok((await card("eig")).ext!.some((e) => e.id === second.id));
  });

  test("said in their own words: a vague 'more' is more of the same kind", async () => {
    llm.on(/asked for more right there/, { items: ["another reason"] });
    const e = await grown(((await grow({ at: "why-0", ask: "more" })).body as { ext: Extension }).ext.id);
    assert.equal(e.shape, "why");
    assert.match(llm.askedFor(/asked for more right there/)[0].user, /so: more of the same/);
  });

  test("said in their own words: the model picks the shape", async () => {
    llm.on(/conversation box on a card/, { kind: "answer", request: "x" });
    llm.on(/asked for more right there/, { shape: "example", items: ["Take the matrix [[2,0],[0,1]]"] });
    const e = await grown(((await grow({ at: "what-0", ask: "show me with an actual matrix" })).body as { ext: Extension }).ext.id);
    assert.equal(e.shape, "example");
  });

  test("asking a piece for a thing makes that thing on its own card, hung from the piece", async () => {
    llm.on(/conversation box on a card/, { kind: "plot", request: "the stretch factor" });
    llm.on(/You plot mathematics/, { title: "Stretch", series: [{ fn: "2x" }] });
    const e = await grown(((await grow({ at: "what-0", ask: "can you plot the stretch?" })).body as { ext: Extension }).ext.id);
    assert.ok(e.made);
    assert.equal(e.items![0], "Plotting: the stretch factor");
    const made = await until(async () => ((await card(e.made!))?.stage === "done" ? card(e.made!) : null), 15000, "the plot");
    assert.equal(made.selection, "Eigenvectors in one line", "hung from the piece's words");
  });

  test("a piece and a shape (or words) are required", async () => {
    assert.equal((await grow({ at: "what-0" })).status, 400);
    assert.equal((await grow({ shape: "why" })).status, 400);
    assert.equal((await grow({ at: "what-0", shape: "dance" })).status, 400);
  });
});

describe("F-GOALS: what you're after, kept as a tree", () => {
  const goals = async () => (await view()).goals ?? [];
  const add = (text: string, parentId?: string) => s.api("POST", "/api/canvases/grow0001/goals", { text, parentId }).then((r) => r.body.goal as Goal);
  const change = (id: string, body: object) => s.api("PATCH", `/api/canvases/grow0001/goals/${id}`, body).then((r) => r.body.goal as Goal);

  test("a card the librarian makes is placed under a goal", async () => {
    llm.on(/keep track of what a learner is after/, { new: { text: "Understand eigenvectors", parent: null, kind: "goal" } });
    llm.on(/conversation box on a card/, { kind: "graph", request: "how they connect" });
    llm.on(/You draw a graph/, { title: "Links", nodes: [{ id: "a", label: "A" }], edges: [] });
    await s.api("POST", "/api/canvases/grow0001/cards/eig/chat", { text: "draw how these connect" });
    const g = await until(async () => (await goals()).find((x) => x.text === "Understand eigenvectors" && x.cards.length), 15000, "a goal");
    assert.equal(g.kind, "goal");
    assert.equal(g.by, "librarian");
  });

  test("add your own, with subgoals; reword one and what it was is kept; finish it", async () => {
    const top = await add("Read the spectral theorem");
    const sub = await add("Know what self-adjoint means", top.id);
    assert.deepEqual([sub.kind, sub.parentId], ["subgoal", top.id]);
    const re = await change(sub.id, { text: "Know what a self-adjoint operator is" });
    assert.deepEqual(re.was, ["Know what self-adjoint means"]);
    assert.equal((await change(sub.id, { status: "done" })).status, "done");
    assert.equal((await s.api("POST", "/api/canvases/grow0001/goals", { text: " " })).status, 400);
  });

  test("a goal never goes under itself or one of its own", async () => {
    const a = await add("A");
    const b = await add("B", a.id);
    assert.equal((await change(a.id, { parentId: b.id })).parentId, undefined);
    assert.equal((await change(b.id, { parentId: null })).kind, "goal"); // to the top
  });

  test("a card works toward one goal: giving it to another moves it", async () => {
    const a = await add("First");
    const b = await add("Second");
    await change(a.id, { addCard: "eig" });
    await change(b.id, { addCard: "eig" });
    const now = await goals();
    assert.ok(!now.find((g) => g.id === a.id)!.cards.includes("eig"));
    assert.ok(now.find((g) => g.id === b.id)!.cards.includes("eig"));
  });

  test("undo puts a goal back exactly as it was", async () => {
    const a = await add("Before");
    await change(a.id, { text: "After" });
    await change(a.id, { restore: a });
    assert.equal((await goals()).find((g) => g.id === a.id)!.text, "Before");
  });
});
