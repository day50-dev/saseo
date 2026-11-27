// F-SET: a card set, a collection to look through as tiles. The model names the entries and says
// why each belongs; Wikipedia vouches for each (picture, description, link), and an entry it can't
// find is flagged. Through the real server, a fake model and a stand-in Wikipedia.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, CardItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url, { LIBRARIAN_WIKIPEDIA: llm.url, LIBRARIAN_TTS_URL: llm.url, LIBRARIAN_STT_URL: llm.url });
let s: TestServer;
const C = "/api/canvases/sets0001";

before(async () => {
  seed(env.LIBRARIAN_DATA, [{ id: "sets0001", name: "Post-punk", items: [explained("pp", "British post-punk", 0, 0, { h: 500 })] }]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});
beforeEach(() => {
  llm.reset();
  llm.wikiPage("Joy Division", { description: "English rock band", extract: "Joy Division were an English rock band formed in Salford in 1976.", thumbnail: { source: "https://upload.example/jd.jpg" }, content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Joy_Division" } } });
  // No lead image: its first real figure, passing over an icon and a tiny inline image.
  llm.wikiPage("Wire (band)", {
    description: "English rock band",
    content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Wire_(band)" } },
    media: [
      { type: "image", title: "File:Music_icon.svg", showInGallery: true, srcset: [{ src: "//upload.example/thumb/400px-Music_icon.svg.png" }] },
      { type: "image", title: "File:Tiny.png", showInGallery: true, srcset: [{ src: "//upload.example/thumb/40px-Tiny.png" }] },
      { type: "image", title: "File:Wire_live_1978.jpg", showInGallery: true, srcset: [{ src: "//upload.example/thumb/330px-Wire_live_1978.jpg" }] },
    ],
  });
  // The model's title is a disambiguation page; search finds the band.
  llm.wikiPage("The Fall", { type: "disambiguation", description: "Topics referred to by the same term" });
  llm.wikiPage("The Fall (band)", { description: "English post-punk band", thumbnail: { source: "https://upload.example/fall.jpg" }, content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/The_Fall_(band)" } } }, "The Fall");
  llm.on(/notable people, groups, works, places or things/, {
    title: "Top talents of British post-punk",
    caption: "The bands that defined the sound.",
    entries: [
      { name: "Joy Division", wikipedia: "Joy Division", subtitle: "band, 1976–1980", note: "Turned bleakness into a template for the genre." },
      { name: "The Fall", wikipedia: "The Fall", subtitle: "band, 1976–2018", note: "Mark E. Smith's long, abrasive run." },
      { name: "Wire", wikipedia: "Wire (band)", subtitle: "band", note: "Art-school minimalism." },
      { name: "The Shimmering Nobodies", wikipedia: "The Shimmering Nobodies", subtitle: "band", note: "Not a real band." },
      { name: "Joy Division", wikipedia: "Joy Division", note: "Twice." },
    ],
  });
});

const card = async (id: string) => ((await s.api("GET", C)).body as CanvasState).items.find((i) => i.id === id) as CardItem;

describe("F-SET: a set of cards to look through", () => {
  test("asked for in a card's conversation, it lands beside it: checked on Wikipedia, the unfound flagged, no repeats", async () => {
    llm.on(/conversation box on a card/, { kind: "set", request: "the top talents of the era" });
    await s.api("POST", `${C}/cards/pp/chat`, { text: "who were the top talents of the era? list some so I can look at them" });
    const id = (await until(async () => (await card("pp")).chat?.at(-1)?.objectId, 10_000, "the set card")) as string;
    const c = await until(async () => {
      const x = await card(id);
      return x.stage === "done" ? x : null;
    }, 10_000, "the set");
    assert.equal(c.objectKind, "set");
    assert.equal(c.w, 960, "room for three across");
    assert.equal(c.subject, "Top talents of British post-punk");
    const o = c.object as Extract<CardItem["object"], { type: "set" }>;
    assert.equal(o.caption, "The bands that defined the sound.");
    assert.deepEqual(o.entries.map((e) => e.title), ["Joy Division", "The Fall", "Wire", "The Shimmering Nobodies"], "shown without Wikipedia's \"(band)\"");
    const [jd, fall, wire, fake] = o.entries;
    assert.equal(wire.image, "https://upload.example/thumb/330px-Wire_live_1978.jpg", "no lead image: its first real figure");
    assert.deepEqual([jd.image, jd.url, jd.subtitle, jd.note], ["https://upload.example/jd.jpg", "https://en.wikipedia.org/wiki/Joy_Division", "band, 1976–1980", "Turned bleakness into a template for the genre."]);
    assert.match(jd.extract!, /Salford/);
    assert.equal(fall.url, "https://en.wikipedia.org/wiki/The_Fall_(band)", "a disambiguation page is passed over for the search's hit");
    assert.equal(fake.unverified, true);
    assert.equal(fake.image, undefined);
  });

  test("a call can ask for one, by name", async () => {
    llm.on(/voice call/, { say: "I'll put together a set of them.", actions: [{ kind: "find", find: "set", request: "top talents of British post-punk" }] });
    const r = await s.api("POST", `${C}/call`, { text: "can you make a card that lists the top talents of the era so I can look at them", pointing: { cardId: "pp" } });
    assert.match(r.body.did, /finding set/);
    assert.match(llm.askedFor(/voice call/)[0].system, /"set" \| "gallery" \| "videos"/);
  });
});
