// F-DESK: the append-only log behind every canvas, and the index of canvases.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { testEnv, useEnv } from "../helpers/env.ts";
import type { CardItem, ImageItem, RegionItem } from "../../shared/canvas.ts";

const env = testEnv("http://127.0.0.1:9");
useEnv(env);
const C = await import("../../server/canvas.ts");

const card = (id: string, parentId: string, x: number, y: number, extra: Partial<CardItem> = {}): CardItem => ({ kind: "card", id, parentId, x, y, w: 300, h: 100, stage: "done", ...extra });
const image = (id: string): ImageItem => ({ kind: "image", id, asset: "0123456789abcdef.png", name: "slide", x: 0, y: 0, w: 1000, h: 500, naturalW: 2000, naturalH: 1000 });

describe("F-DESK-1: canvases", () => {
  test("created with a name, or the default", async () => {
    const a = await C.createCanvas("  My   study ");
    assert.equal(a.name, "My study");
    const b = await C.createCanvas("");
    assert.equal(b.name, C.DEFAULT_NAME);
    assert.ok((await C.listCanvases()).some((c) => c.id === a.id));
  });

  test("renamed, trashed and taken out of the trash", async () => {
    const a = await C.createCanvas("x");
    assert.equal((await C.updateCanvas(a.id, { name: "y" }))!.name, "y");
    assert.ok((await C.updateCanvas(a.id, { trashed: true }))!.trashedAt);
    assert.equal((await C.updateCanvas(a.id, { trashed: false }))!.trashedAt, undefined);
    assert.equal(await C.updateCanvas("nope", { name: "z" }), null);
  });

  test("an untitled canvas is named after what's on it, once; a chosen name never is", async () => {
    const a = await C.createCanvas("");
    const items = [card("c1", "", 0, 0, { origin: { kind: "page", url: "https://x", title: "Eigenvalues and eigenvectors" } as CardItem["origin"] })];
    assert.equal(C.nameFromItems(items), "Eigenvalues and eigenvectors");
    assert.equal((await C.autoName(a.id, "Eigenvalues and eigenvectors"))!.name, "Eigenvalues and eigenvectors");
    assert.equal((await C.autoName(a.id, "Something else"))!.name, "Eigenvalues and eigenvectors");
    assert.equal(C.nameFromItems([card("c", "", 0, 0, { subject: "https://bare.link" })]), "");
    assert.equal(C.nameFromItems([card("c", "", 0, 0, { subject: "x".repeat(200) })]).length <= 81, true);
  });

  test("duplicated with everything on it, and deleted for good", async () => {
    const a = await C.createCanvas("orig");
    const s = (await C.canvasStore(a.id))!;
    await s.add(card("k1", "", 0, 0));
    const copy = (await C.duplicateCanvas(a.id))!;
    assert.equal(copy.name, "Copy of orig");
    const cs = (await C.canvasStore(copy.id))!;
    assert.deepEqual((await cs.getState()).items.map((i) => i.id), ["k1"]);
    assert.equal(await C.deleteCanvas(copy.id), true);
    assert.equal(await C.canvasStore(copy.id), undefined);
    assert.equal(await C.deleteCanvas(copy.id), false);
  });

  test("reader notes are kept, the last twelve", async () => {
    const a = await C.createCanvas("n");
    for (let i = 0; i < 15; i++) await C.addReaderNote(a.id, { q: "q", a: `a${i}`, at: "" } as never);
    const info = (await C.getCanvasInfo(a.id))!;
    assert.equal(info.reader!.length, 12);
    assert.equal(info.reader!.at(-1)!.a, "a14");
  });
});

describe("F-DESK-2: nothing is lost", () => {
  let s: InstanceType<typeof C.CanvasStore>;
  before(async () => {
    s = (await C.canvasStore((await C.createCanvas("log")).id))!;
  });

  test("every change is a numbered line in the log", async () => {
    await s.add(card("a", "", 0, 0));
    await s.update("a", { subject: "Eigenvectors" });
    await s.record({ type: "chat", id: "a", message: { role: "user", text: "hi", at: "" } });
    const state = await s.getState();
    const lines = readFileSync(path.join(env.LIBRARIAN_DATA, "canvases", `${s.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3]);
    assert.equal(state.seq, 3);
    const a = state.items[0] as CardItem;
    assert.equal(a.subject, "Eigenvectors");
    assert.equal(a.chat![0].text, "hi");
  });

  test("the log replays to the same state after a restart", async () => {
    const fresh = new C.CanvasStore(s.id);
    const before = JSON.stringify((await s.getState()).items);
    assert.equal(JSON.stringify((await fresh.getState()).items), before);
  });

  test("removing hides; showing brings it back", async () => {
    await s.record({ type: "hide", ids: ["a"] });
    assert.equal((await s.findItem("a"))!.hidden, true);
    await s.record({ type: "show", ids: ["a"] });
    assert.equal((await s.findItem("a"))!.hidden, false);
  });

  test("collapse and restack", async () => {
    await s.record({ type: "collapse", ids: ["a"], collapsed: true });
    assert.equal((await s.findItem("a"))!.collapsed, true);
    await s.record({ type: "z", order: [{ id: "a", z: 7 }] });
    assert.equal(((await s.findItem("a")) as CardItem).z, 7);
  });

  test("work in progress is shown but never written", async () => {
    s.setLive("a", { subject: "half drawn" });
    assert.equal(((await s.view()).items[0] as CardItem).subject, "half drawn");
    assert.equal(((await s.getState()).items[0] as CardItem).subject, "Eigenvectors");
    s.clearLive("a");
  });

  test("edits made from the current value don't overwrite each other", async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => s.edit("a", (i) => ({ ext: [...((i as CardItem).ext ?? []), { id: `e${n}`, at: "what-0", shape: "aside", status: "done" }] }))),
    );
    assert.equal(((await s.findItem("a")) as CardItem).ext!.length, 5);
  });

  test("a card left mid-flight by a restart is marked failed, not left spinning", async () => {
    await s.add(card("busy", "", 2000, 0, { stage: "writing" }));
    await s.add(card("talk", "", 4000, 0, { chatPending: true }));
    await s.settled();
    const restarted = new C.CanvasStore(s.id);
    const busy = (await restarted.findItem("busy")) as CardItem;
    assert.equal(busy.stage, "failed");
    assert.match(busy.error!, /restart/);
    const talk = (await restarted.findItem("talk")) as CardItem;
    assert.equal(talk.chatPending, false);
    assert.match(talk.chat!.at(-1)!.text, /Interrupted/);
  });
});

describe("F-DESK-3: what goes with what", () => {
  let s: InstanceType<typeof C.CanvasStore>;
  before(async () => {
    s = (await C.canvasStore((await C.createCanvas("tree")).id))!;
    const region: RegionItem = { kind: "region", id: "r", imageId: "img", rect: { x: 100, y: 100, w: 100, h: 50 } };
    await s.add(image("img"));
    await s.add(region);
    await s.add(card("onbox", "r", 1100, 0));
    await s.add(card("child", "onbox", 1500, 0));
    await s.add(card("other", "", 3000, 0));
    await s.add(card("rel", "onbox", 2000, 600, { relates: ["onbox", "other"] }));
  });

  test("an image takes its boxes, a box its cards, a card the cards below it, a relation either side", async () => {
    assert.deepEqual((await s.withDependents(["img"])).sort(), ["child", "img", "onbox", "r", "rel"].sort());
    assert.deepEqual((await s.withDependents(["other"])).sort(), ["other", "rel"]);
  });

  test("removing the only card on a box takes the box too", async () => {
    assert.ok((await s.withDependents(["onbox"])).includes("r"));
  });

  test("an explanation can sit on any side of what it explains, but not on it", async () => {
    // "child" hangs from "onbox" at (1100,0) 300×100. Directly on top: refused.
    const bad = await s.moveItems([{ id: "child", x: 1150, y: 20 }]);
    assert.equal(bad.ok, false);
    for (const [x, y] of [[1500, 0], [600, 0], [1100, 200], [1100, -300]]) assert.equal((await s.moveItems([{ id: "child", x, y }])).ok, true, `${x},${y}`);
    // Moving the slide under its box's card is refused too.
    assert.equal((await s.moveItems([{ id: "img", x: 1000, y: 0 }])).ok, false);
  });

  test("moves are checked and rounded; only cards change width, within limits", async () => {
    assert.equal((await s.moveItems([{ id: "r", x: 0, y: 0 }])).ok, false);
    assert.equal((await s.moveItems([{ id: "other", x: Number.NaN, y: 0 }])).ok, false);
    assert.equal((await s.moveItems([{ id: "img", x: 0, y: 0, w: 500 }])).ok, false);
    await s.moveItems([{ id: "other", x: 3000.6, y: 10.4, w: 99999 }]);
    const o = (await s.findItem("other")) as CardItem;
    assert.deepEqual([o.x, o.y, o.w], [3001, 10, 4000]);
  });
});

describe("F-DESK-4: images", () => {
  test("stored once by content hash; only image types", async () => {
    const bytes = Buffer.from("png bytes");
    const a = await C.saveAsset(bytes, "image/png");
    assert.equal(a, await C.saveAsset(bytes, "image/png"));
    assert.match(a, /^[0-9a-f]{16}\.png$/);
    await assert.rejects(C.saveAsset(bytes, "text/html"));
    assert.equal(C.assetPath("../config.json"), null);
    assert.equal(C.assetPath(a)!.mime, "image/png");
  });
});

after(() => {});
