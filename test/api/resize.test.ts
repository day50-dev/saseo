// Resizing things on the canvas: a video or a PDF can be made bigger or smaller and keeps its
// shape; a picture can't be stretched by a move.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv } from "../helpers/env.ts";
import { seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CanvasState, ImageItem } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
const C = "/api/canvases/size0001";

const video: ImageItem = { kind: "image", id: "vid", x: 0, y: 0, w: 720, h: 405, naturalW: 1280, naturalH: 720, asset: "v.jpg", name: "A lecture", video: { videoId: "abc123", title: "A lecture", channel: "A channel", duration: 600 } };
const pdf: ImageItem = { kind: "image", id: "pdf", x: 0, y: 2000, w: 600, h: 776, naturalW: 1224, naturalH: 1584, asset: "d.png", name: "A paper", doc: { file: "d.pdf", pages: 12, url: "https://example.org/d.pdf", title: "A paper" } };
const picture: ImageItem = { kind: "image", id: "pic", x: 0, y: 1000, w: 400, h: 300, naturalW: 400, naturalH: 300, asset: "p.png", name: "A picture" };

before(async () => {
  seed(env.LIBRARIAN_DATA, [{ id: "size0001", name: "Sizes", items: [video, pdf, picture] }]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});

const item = async (id: string) => ((await s.api("GET", C)).body as CanvasState).items.find((i) => i.id === id) as ImageItem;

describe("F-VIDEO-SIZE: videos and PDFs can be resized", () => {
  test("a wider video keeps its shape", async () => {
    const r = await s.api("POST", `${C}/move`, { moves: [{ id: "vid", x: 0, y: 0, w: 1080 }] });
    assert.equal(r.status, 200);
    const v = await item("vid");
    assert.equal(v.w, 1080);
    assert.equal(v.h, 608);
  });
  test("there are limits either way", async () => {
    await s.api("POST", `${C}/move`, { moves: [{ id: "vid", x: 0, y: 0, w: 50 }] });
    assert.equal((await item("vid")).w, 320);
    await s.api("POST", `${C}/move`, { moves: [{ id: "vid", x: 0, y: 0, w: 99999 }] });
    assert.equal((await item("vid")).w, 1920);
  });
  test("moving it without a width leaves its size alone", async () => {
    await s.api("POST", `${C}/move`, { moves: [{ id: "vid", x: 40, y: 0 }] });
    const v = await item("vid");
    assert.equal(v.x, 40);
    assert.equal(v.w, 1920);
  });
  test("a PDF can be resized too, keeping its shape, within its own limits", async () => {
    assert.equal((await s.api("POST", `${C}/move`, { moves: [{ id: "pdf", x: 0, y: 2000, w: 900 }] })).status, 200);
    const d = await item("pdf");
    assert.equal(d.w, 900);
    assert.equal(d.h, 1164);
    await s.api("POST", `${C}/move`, { moves: [{ id: "pdf", x: 0, y: 2000, w: 100 }] });
    assert.equal((await item("pdf")).w, 480, "wide enough for its pager");
  });
  test("a picture's width can't be set", async () => {
    const r = await s.api("POST", `${C}/move`, { moves: [{ id: "pic", x: 0, y: 1000, w: 800 }] });
    assert.equal(r.status, 409);
    assert.equal((await item("pic")).w, 400);
  });
});
