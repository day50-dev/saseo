// A goal is the lens cards are written through; cards written before it can be written again
// through it, and undo puts back what they said.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem, Goal } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
const C = "/api/canvases/lens0001";
const sources = [{ n: 1, url: "https://example.org/eig", title: "Eigenvectors", snippet: "A vector a matrix only stretches.", searcher: "wikipedia" as const }];

before(async () => {
  seed(env.LIBRARIAN_DATA, [
    {
      id: "lens0001",
      name: "Lens",
      items: [
        explained("q", "What is an eigenvector?", 0, 0, { h: 300 }),
        explained("eig", "Eigenvector", 800, 0, { parentId: "q", selection: "eigenvector", sources, ext: [{ id: "x1", at: "why.0", shape: "more", status: "done" } as never] }),
      ],
    },
  ]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});

const state = async () => (await s.api("GET", C)).body as CanvasState;
const card = async (id: string) => (await state()).items.find((i) => i.id === id) as CardItem;

describe("F-GOAL-LENS: re-explaining through a goal", () => {
  test("the cards a goal is the lens for are written again through it, and undo swaps them back", async () => {
    llm.on(/./, {});
    llm.on(/lens for everything/, { why: ["Games turn and scale things every frame"], what: { gist: "The direction a transform leaves pointing the same way", details: [] }, parts: [], together: "", here: ["A camera's spin axis"], name: "" });
    const { goal } = (await s.api("POST", `${C}/goals`, { text: "Make a 3D game" })).body as { goal: Goal };
    const r = await s.api("POST", `${C}/goals/${goal.id}/reexplain`, {});
    assert.equal(r.status, 200);
    const ids = (r.body as { ids: string[] }).ids;
    assert.ok(ids.includes("eig"), `eig is re-explained: ${ids}`);
    await until(async () => (await card("eig")).lens?.includes("Make a 3D game") === true, 10000, "rewritten through the goal");
    const now = await card("eig");
    assert.equal(now.stage, "done");
    assert.match(now.sem!.what.gist, /transform/);
    assert.equal(now.ext?.length ?? 0, 0, "what was grown from the old words is set aside");
    assert.equal(now.before?.ext?.length, 1);
    const prompt = llm.askedFor(/lens for everything/).at(-1)!;
    assert.match(prompt.user, /Make a 3D game/);
    // Written through it now: nothing left to re-explain.
    assert.deepEqual(((await s.api("POST", `${C}/goals/${goal.id}/reexplain`, {})).body as { ids: string[] }).ids.filter((i) => i === "eig"), []);
    // Undo: the old words come back, with what was grown from them.
    assert.equal((await s.api("POST", `${C}/cards/eig/swap`, {})).status, 200);
    const back = await card("eig");
    assert.match(back.sem!.what.gist, /Eigenvector in one line/);
    assert.equal(back.ext?.length, 1);
    // Redo: the goal's version again.
    await s.api("POST", `${C}/cards/eig/swap`, {});
    assert.match((await card("eig")).sem!.what.gist, /transform/);
  });
  test("a goal they cleared isn't a lens", async () => {
    const { goal } = (await s.api("POST", `${C}/goals`, { text: "Pass the exam" })).body as { goal: Goal };
    await s.api("PATCH", `${C}/goals/${goal.id}`, { status: "dropped" });
    assert.equal((await s.api("POST", `${C}/goals/${goal.id}/reexplain`, {})).status, 409);
  });
});
