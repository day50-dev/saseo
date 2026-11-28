// Checking the working in a box on a photo: read by the model, judged by SymPy, said by the model.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem, ImageItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
const C = "/api/canvases/work0001";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const photo: ImageItem = { kind: "image", id: "hw", x: 0, y: 0, w: 900, h: 675, naturalW: 1600, naturalH: 1200, asset: "hw.jpg", name: "homework.jpg" };

before(async () => {
  seed(env.LIBRARIAN_DATA, [{ id: "work0001", name: "Homework", items: [photo] }]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});

const card = async (id: string) => ((await s.api("GET", C)).body as CanvasState).items.find((i) => i.id === id) as CardItem;

describe("F-CHECK: checking the working in a box", () => {
  test("the model reads it, SymPy finds the first wrong line, and the model says what went wrong there", async () => {
    llm.on(/./, {});
    llm.on(/own written working/, {
      problem: "Solve for x",
      steps: [
        { latex: "3(x-2)+4 = 2x+9", sympy: "3*(x-2)+4 = 2*x+9" },
        { latex: "3x-6+4 = 2x+9", sympy: "3*x-6+4 = 2*x+9" },
        { latex: "3x+2 = 2x+9", sympy: "3*x+2 = 2*x+9" },
        { latex: "x = 7", sympy: "x = 7" },
      ],
    });
    llm.on(/patient tutor/, { verdict: "Line 3 doesn't follow; the rest follows from it.", why: "\\(-6+4\\) is \\(-2\\).", hint: "Combine the numbers again." });
    const r = await s.api("POST", `${C}/regions`, { imageId: "hw", rect: { x: 100, y: 100, w: 600, h: 700 }, card: { x: 1000, y: 0 }, marked: PNG, crop: PNG, check: true });
    assert.equal(r.status, 200);
    const id = (r.body as { card: CardItem }).card.id;
    await until(async () => (await card(id)).stage === "done", 20000, "checked");
    const c = await card(id);
    assert.equal(c.check, true);
    assert.equal(c.subject, "Solve for x");
    assert.deepEqual(c.work!.steps.map((x) => x.status), ["given", "ok", "wrong", "ok"]);
    assert.equal(c.work!.wrongAt, 2);
    assert.match(c.work!.why!, /-2/);
    assert.equal(c.work!.hint, "Combine the numbers again.");
    // What SymPy found is what the model was told.
    const told = llm.askedFor(/patient tutor/).at(-1)!;
    assert.match(told.user, /3\. 3x\+2 = 2x\+9\s+\[wrong/);
    assert.match(told.user, /first step that doesn't follow is line 3/);
  });
  test("all of it right: no wrong line, no why or hint", async () => {
    llm.on(/own written working/, { problem: "", steps: [{ latex: "(x+1)^2", sympy: "(x+1)**2" }, { latex: "x^2+2x+1", sympy: "x**2+2*x+1" }] });
    llm.on(/patient tutor/, { verdict: "Every step follows.", why: "made up", hint: "made up" });
    const id = ((await s.api("POST", `${C}/regions`, { imageId: "hw", rect: { x: 0, y: 0, w: 50, h: 50 }, card: { x: 1000, y: 900 }, marked: PNG, crop: PNG, check: true })).body as { card: CardItem }).card.id;
    await until(async () => (await card(id)).stage === "done", 20000, "checked");
    const w = (await card(id)).work!;
    assert.equal(w.wrongAt, undefined);
    assert.equal(w.why, undefined);
    assert.equal(w.hint, undefined);
    assert.equal((await card(id)).subject, "Your work");
  });
  test("nothing to read in the box: the card says so", async () => {
    llm.on(/own written working/, { problem: "", steps: [] });
    const id = ((await s.api("POST", `${C}/regions`, { imageId: "hw", rect: { x: 0, y: 0, w: 50, h: 50 }, card: { x: 1000, y: 1800 }, marked: PNG, crop: PNG, check: true })).body as { card: CardItem }).card.id;
    await until(async () => (await card(id)).stage === "failed", 20000, "failed");
    assert.match((await card(id)).error ?? "", /Couldn.t find any math/);
  });
});
