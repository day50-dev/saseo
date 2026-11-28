// F-RETRY: a failed card tries again by itself, waiting longer each time, up to RETRY_TRIES; and a
// card a restart interrupted starts over by itself. Through the real server and a fake model.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, objectCard, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import { RETRY_TRIES, type CanvasState, type CardItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
const C = "/api/canvases/retr0001";
const PLOT = { title: "Sine", x: { min: 0, max: 6 }, y: {}, series: [{ label: "sin", fn: "sin(x)" }] };

before(async () => {
  seed(env.LIBRARIAN_DATA, [
    {
      id: "retr0001",
      name: "Retry",
      items: [
        explained("src", "Waves", 0, 0, { h: 400 }),
        // Left mid-flight when the server stopped.
        // Interrupted too, but it has used all its tries.
        { ...objectCard("spent", { type: "plot", title: "", plot: { x: {}, y: {}, series: [] } }, 900, 900), object: undefined, objectKind: "plot", request: "x", stage: "writing", retries: 5 } as CardItem,
        // A linked page that can never be read here (it points inside a private network).
        { kind: "card", id: "never", parentId: "", origin: { kind: "page", url: "http://localhost/notes", title: "notes" }, x: 0, y: 900, w: 600, stage: "reading", subject: "notes" } as CardItem,
        { ...objectCard("stuck", { type: "plot", title: "", plot: { x: {}, y: {}, series: [] } }, 900, 0), object: undefined, objectKind: "plot", request: "sin x", stage: "writing" } as CardItem,
      ],
    },
  ]);
  llm.on(/You plot mathematics/, PLOT);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});

const card = async (id: string) => ((await s.api("GET", C)).body as CanvasState).items.find((i) => i.id === id) as CardItem;

describe("F-RETRY: failed cards try again by themselves", () => {
  test("a card a restart interrupted starts over by itself and finishes", async () => {
    const c = await until(async () => {
      const x = await card("stuck");
      return x.stage === "done" ? x : null;
    }, 15_000, "the interrupted card to finish");
    assert.equal(c.object?.type, "plot");
    assert.equal(c.retries, 0, "the count resets once it works");
  });

  test("a failure says when it will try again, and then it does, and succeeds", async () => {
    llm.reset();
    llm.on(/conversation box on a card/, { kind: "plot", request: "cos x" });
    // No plot rule yet: the model fails.
    await s.api("POST", `${C}/cards/src/chat`, { text: "plot cos x" });
    const id = (await until(async () => (await card("src")).chat?.at(-1)?.objectId, 10_000, "the plot card")) as string;
    const failed = await until(async () => {
      const x = await card(id);
      return x.stage === "failed" && x.retryAt ? x : null;
    }, 15_000, "the failure");
    assert.equal(failed.retries, 1);
    const wait = Date.parse(failed.retryAt!) - Date.now();
    assert.ok(wait > 0 && wait <= 2000, `first wait about 2 s: ${wait}`);
    llm.on(/You plot mathematics/, PLOT);
    const done = await until(async () => {
      const x = await card(id);
      return x.stage === "done" ? x : null;
    }, 10_000, "the retry to succeed");
    assert.equal(done.object?.type, "plot");
  });

  test("a card that has used all its tries stops, and waits for Retry", async () => {
    const c = await card("spent");
    assert.equal(c.stage, "failed");
    assert.equal(c.retryAt, "");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await card("spent")).stage, "failed", "it didn't start over");
  });

  test("a failure trying again can't fix (a link that can't be read here) says so once, and doesn't retry", async () => {
    const c = await until(async () => {
      const x = await card("never");
      return x.stage === "failed" ? x : null;
    }, 15_000, "the page to fail");
    assert.match(c.error ?? "", /private network/);
    assert.equal(c.retryAt ?? "", "", "no next try is set");
    await new Promise((r) => setTimeout(r, 2500));
    const later = await card("never");
    assert.equal(later.stage, "failed", "it didn't start over");
    assert.equal(later.retries, c.retries, "it didn't try again");
  });

  test("Retry by hand gives back every try", async () => {
    llm.reset();
    llm.on(/conversation box on a card/, { kind: "plot", request: "tan x" });
    await s.api("POST", `${C}/cards/src/chat`, { text: "plot tan x" });
    const id = (await until(async () => {
      const m = (await card("src")).chat?.at(-1);
      return m?.objectId && m.text.includes("tan") ? m.objectId : null;
    }, 10_000, "the plot card")) as string;
    await until(async () => ((await card(id)).retries === 1 ? true : null), 15_000, "the first failure");
    // Pressing Retry resets the count.
    assert.equal((await s.api("POST", `${C}/cards/${id}/retry`, {})).status, 200);
    await until(async () => {
      const x = await card(id);
      return x.stage === "failed" && x.retries === 1 ? x : null;
    }, 15_000, "a fresh first try");
    assert.equal(RETRY_TRIES, 5);
  });
});
