// F-GALLERY: pictures to look through. Candidates from Wikimedia Commons (and the pages search finds);
// the model picks and captions them; each picked picture is fetched and kept as an asset. Through the
// real server, a fake model and a stand-in Commons.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url, { LIBRARIAN_COMMONS: `${llm.url}/w/api.php` });
let s: TestServer;
const C = "/api/canvases/gall0001";

before(async () => {
  seed(env.LIBRARIAN_DATA, [{ id: "gall0001", name: "Mickey", items: [explained("mm", "Mickey Mouse's model sheet evolution", 0, 0, { h: 500 })] }]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});
beforeEach(() => {
  llm.reset();
  llm.commonsImages([
    { file: "Steamboat_Willie_1928.png", description: "Mickey Mouse in <i>Steamboat Willie</i>", date: "1928", w: 1200, h: 900 },
    { file: "Disney_logo.png", description: "The Walt Disney Company logo", w: 800, h: 300 },
    { file: "Mickey_1940_model_sheet.png", description: "Model sheet of Mickey Mouse, 1940", date: "1940", w: 1000, h: 1300 },
    { file: "Tiny_mickey.png", description: "A small Mickey", w: 120, h: 120 },
  ]);
});

const card = async (id: string) => ((await s.api("GET", C)).body as CanvasState).items.find((i) => i.id === id) as CardItem;

describe("F-GALLERY: pictures to look through", () => {
  test("asked for in a card's conversation: picked, captioned, oldest first, each kept on the server", async () => {
    llm.on(/conversation box on a card/, { kind: "gallery", request: "Mickey's model sheets over the years" });
    llm.on(/Write two searches/, { web: "Mickey Mouse model sheets history", commons: "Mickey Mouse" });
    llm.on(/numbered candidate images/, (a) => {
      assert.match(a.user, /Steamboat Willie/);
      assert.doesNotMatch(a.user, /A small Mickey/, "too small to be a candidate");
      return {
        title: "Mickey's model sheets",
        caption: "How the drawing guide changed.",
        images: [
          { n: 1, caption: "Mickey as first drawn, in rubber-hose style.", when: "1928" },
          { n: 3, caption: "The 1940 model sheet: pear-shaped body, eyes with pupils.", when: "1940" },
          { n: 2, caption: "The company's logo." },
          { n: 99, caption: "Not a candidate." },
        ],
      };
    });
    // Looking at them: the logo doesn't show what was asked.
    llm.on(/Look at each image/, (a) => {
      assert.equal((a.messages.at(-1)!.content as { type: string }[]).filter((x) => x.type === "image_url").length, 3, "the pictures themselves, to look at");
      return { images: [{ keep: true, caption: "Mickey at the wheel of the steamboat, pie-cut eyes." }, { keep: true, caption: "A 1940 model sheet." }, { keep: false }] };
    });
    await s.api("POST", `${C}/cards/mm/chat`, { text: "show me pictures of his model sheets over the years" });
    const id = (await until(async () => (await card("mm")).chat?.at(-1)?.objectId, 10_000, "the gallery card")) as string;
    const c = await until(async () => {
      const x = await card(id);
      return x.stage === "done" || x.stage === "failed" ? x : null;
    }, 10_000, "the gallery");
    assert.equal(c.stage, "done", String(c.error));
    assert.equal(c.objectKind, "gallery");
    assert.equal(c.w, 960, "room for three across");
    assert.equal(c.subject, "Mickey's model sheets");
    const o = c.object as Extract<CardItem["object"], { type: "gallery" }>;
    assert.deepEqual(o.images.map((i) => [i.when, i.w, i.h, i.site]), [["1928", 1200, 900, "Wikimedia Commons"], ["1940", 1000, 1300, "Wikimedia Commons"]]);
    assert.match(o.images[0].page, /commons\.wikimedia\.org\/wiki\/File:Steamboat/);
    assert.equal(o.images[0].credit, "Public domain");
    assert.equal(o.images[0].caption, "Mickey at the wheel of the steamboat, pie-cut eyes.", "captioned from what's in it");
    const pic = await fetch(`${s.url}/api/assets/${o.images[0].asset}`);
    assert.equal(pic.headers.get("content-type"), "image/png", "kept on the server, not linked");
  });
});
