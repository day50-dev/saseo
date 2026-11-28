// Looking at someone's own work in a box on a photo: read by the model, the algebra followed by SymPy
// underneath, and what they're doing named by the model.
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

describe("F-WORK: looking at someone's own work", () => {
  test("the model reads it, SymPy's evidence goes to the model, and the card names what they're doing", async () => {
    llm.on(/./, {});
    llm.on(/own written work/, {
      problem: "A linear equation",
      steps: [
        { latex: "3(x-2)+4 = 2x+9", sympy: "3*(x-2)+4 = 2*x+9" },
        { latex: "3x-6+4 = 2x+9", sympy: "3*x-6+4 = 2*x+9" },
        { latex: "3x+2 = 2x+9", sympy: "3*x+2 = 2*x+9" },
        { latex: "x = 7", sympy: "x = 7" },
      ],
    });
    llm.on(/colleague's own work/, {
      opening: "You're isolating x.",
      ideas: [
        { name: "Combining like terms", lines: [2, 3], what: "Adding the constants.", note: "The usual sum here is \\(-2\\); you have \\(+2\\).", differs: true, origin: "" },
        { name: "", lines: [1], what: "nameless ideas are dropped", note: "" },
      ],
      invite: "What does line 3 become with \\(-2\\)?",
    });
    const r = await s.api("POST", `${C}/regions`, { imageId: "hw", rect: { x: 100, y: 100, w: 600, h: 700 }, card: { x: 1000, y: 0 }, marked: PNG, crop: PNG, look: true });
    assert.equal(r.status, 200);
    const id = (r.body as { card: CardItem }).card.id;
    await until(async () => (await card(id)).stage === "done", 20000, "looked at");
    const c = await card(id);
    assert.equal(c.look, true);
    assert.equal(c.subject, "A linear equation");
    const w = c.work!;
    assert.deepEqual(w.lines.map((l) => l.follows), [undefined, "yes", "no", "yes"]);
    assert.equal(w.opening, "You're isolating x.");
    assert.deepEqual(w.ideas.map((d) => [d.name, d.lines, d.differs]), [["Combining like terms", [2, 3], true]]);
    assert.match(w.invite, /line 3/);
    // What SymPy found went to the model as evidence, line by line.
    const told = llm.askedFor(/colleague's own work/).at(-1)!;
    assert.match(told.user, /2\. 3x-6\+4 = 2x\+9\s+\[follows\]/);
    assert.match(told.user, /3\. 3x\+2 = 2x\+9\s+\[doesn't follow/);
  });
  test("nothing to read in the box: the card says so", async () => {
    llm.on(/own written work/, { problem: "", steps: [] });
    const id = ((await s.api("POST", `${C}/regions`, { imageId: "hw", rect: { x: 0, y: 0, w: 50, h: 50 }, card: { x: 1000, y: 1800 }, marked: PNG, crop: PNG, look: true })).body as { card: CardItem }).card.id;
    await until(async () => (await card(id)).stage === "failed", 20000, "failed");
    assert.match((await card(id)).error ?? "", /Couldn't find any math/);
  });
});
