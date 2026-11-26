// F-DESK through HTTP, as the page uses it: canvases, images, boxes, moving, removing and bringing
// back, collapsing, restacking, relations, settings, and serving the app.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeLlm } from "../helpers/fakeLlm.ts";
import { testEnv, until } from "../helpers/env.ts";
import { explained, seed } from "../helpers/seed.ts";
import { startServer, type TestServer } from "../helpers/server.ts";
import type { CardItem, CanvasState } from "../../shared/canvas.ts";

const llm = await fakeLlm();
const env = testEnv(llm.url);
let s: TestServer;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

before(async () => {
  seed(env.LIBRARIAN_DATA, [
    {
      id: "desk0001",
      name: "Untitled canvas",
      items: [
        explained("a", "Eigenvectors", 0, 0, { h: 300 }),
        explained("b", "Eigenvalues", 1000, 0, { parentId: "a", h: 300 }),
        explained("c", "Matrices", 2000, 0, { parentId: "b", h: 300 }),
        explained("d", "Unrelated", 0, 2000, { h: 300 }),
      ],
    },
  ]);
  s = await startServer(env);
});
after(async () => {
  await s?.stop();
  await llm.close();
});

const state = async (cid = "desk0001") => (await s.api("GET", `/api/canvases/${cid}`)).body as CanvasState & { name: string };
const item = async (id: string) => (await state()).items.find((i) => i.id === id) as CardItem;

describe("F-DESK-1: named canvases with stable URLs", () => {
  test("create, list, rename, trash, duplicate, delete", async () => {
    const made = (await s.api("POST", "/api/canvases", { name: "Spectral theory" })).body;
    assert.match(made.id, /^[0-9a-f]{8}$/);
    const list = (await s.api("GET", "/api/canvases")).body as { id: string; cards: number }[];
    assert.ok(list.some((c) => c.id === made.id));
    assert.equal(list.find((c) => c.id === "desk0001")!.cards, 4);
    assert.equal((await s.api("PATCH", `/api/canvases/${made.id}`, { name: "Spectra" })).body.name, "Spectra");
    assert.ok((await s.api("PATCH", `/api/canvases/${made.id}`, { trashed: true })).body.trashedAt);
    const copy = (await s.api("POST", "/api/canvases/desk0001/duplicate")).body;
    assert.equal((await state(copy.id)).items.length, 4);
    assert.equal((await s.api("DELETE", `/api/canvases/${copy.id}`)).status, 200);
    assert.equal((await s.api("GET", `/api/canvases/${copy.id}`)).status, 404);
  });

  test("an untitled canvas is named after what it was started with", async () => {
    assert.equal((await state()).name, "Eigenvectors");
  });

  test("an unknown canvas is not found, everywhere", async () => {
    for (const [m, p] of [["GET", "/api/canvases/nope"], ["POST", "/api/canvases/nope/hide"], ["POST", "/api/canvases/nope/move"], ["POST", "/api/canvases/nope/call"]] as const)
      assert.equal((await s.api(m, p, m === "GET" ? undefined : {})).status, 404, p);
  });
});

describe("F-DESK-2: nothing is lost", () => {
  test("removing hides a card and everything below it; showing brings them back", async () => {
    const hidden = (await s.api("POST", "/api/canvases/desk0001/hide", { ids: ["b"] })).body.ids;
    assert.deepEqual(hidden.sort(), ["b", "c"]);
    assert.equal((await item("c")).hidden, true);
    assert.equal((await item("a")).hidden, undefined);
    assert.deepEqual((await s.api("POST", "/api/canvases/desk0001/show", { ids: ["b", "c", "ghost"] })).body.ids, ["b", "c"]);
    assert.equal((await item("c")).hidden, false);
  });

  test("collapse folds a card; restack orders cards and images", async () => {
    assert.equal((await s.api("POST", "/api/canvases/desk0001/collapse", { ids: ["a"], collapsed: true })).status, 200);
    assert.equal((await item("a")).collapsed, true);
    assert.equal((await s.api("POST", "/api/canvases/desk0001/collapse", { ids: ["ghost"], collapsed: true })).status, 400);
    await s.api("POST", "/api/canvases/desk0001/collapse", { ids: ["a"], collapsed: false });
    assert.equal((await s.api("POST", "/api/canvases/desk0001/z", { order: [{ id: "d", z: 9 }] })).status, 200);
    assert.equal((await item("d")).z, 9);
  });
});

describe("F-DESK-3: nothing moves unless you move it", () => {
  test("a move is kept; one onto what a card explains is refused", async () => {
    assert.equal((await s.api("POST", "/api/canvases/desk0001/move", { moves: [{ id: "d", x: 5, y: 2500 }] })).status, 200);
    assert.deepEqual([(await item("d")).x, (await item("d")).y], [5, 2500]);
    const bad = await s.api("POST", "/api/canvases/desk0001/move", { moves: [{ id: "b", x: 10, y: 10 }] });
    assert.equal(bad.status, 409);
    assert.match(bad.body.error, /any side/);
    assert.equal((await s.api("POST", "/api/canvases/desk0001/move", { moves: [] })).status, 400);
  });
});

describe("F-START-1: a screenshot, and a box on it", () => {
  test("an image is stored and served by its hash", async () => {
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "slide.png");
    for (const [k, v] of Object.entries({ x: 0, y: 4000, w: 800, h: 800, naturalW: 1, naturalH: 1 })) form.set(k, String(v));
    const r = await fetch(`${s.url}/api/canvases/desk0001/images`, { method: "POST", body: form });
    const img = await r.json();
    assert.match(img.asset, /^[0-9a-f]{16}\.png$/);
    const got = await fetch(`${s.url}/api/assets/${img.asset}`);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
    assert.equal((await fetch(`${s.url}/api/assets/..%2Fconfig.json`)).status, 404);

    const bad = new FormData();
    bad.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    assert.equal((await fetch(`${s.url}/api/canvases/desk0001/images`, { method: "POST", body: bad })).status, 400);

    // A box makes a region and a card that starts explaining it.
    llm.on(/./, "{}");
    const box = await s.api("POST", "/api/canvases/desk0001/regions", {
      imageId: img.id,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      card: { x: 900, y: 4000 },
      marked: "data:image/png;base64,AAAA",
      crop: "data:image/png;base64,AAAA",
    });
    assert.equal(box.status, 200);
    assert.equal(box.body.card.parentId, box.body.region.id);
    await until(() => llm.asked.some((a) => a.messages.some((m) => Array.isArray(m.content))), 10000, "the crop to go to the model as an image");
    const card = await until(async () => {
      const c = await item(box.body.card.id);
      return c.stage === "done" || c.stage === "failed" || c.stage === "asking" ? c : null;
    }, 15000, "the box's card to settle");
    assert.ok(card);
    assert.equal((await s.api("POST", "/api/canvases/desk0001/regions", { imageId: img.id, rect: {}, card: {}, marked: "x", crop: "y" })).status, 400);
  });
});

describe("F-DESCEND: going one level down", () => {
  test("selected words become a card hanging from the one they're in", async () => {
    llm.reset();
    llm.on(/./, "{}");
    const r = await s.api("POST", "/api/canvases/desk0001/descend", { parentId: "a", selection: " eigenvalue ", context: "Its stretch is the eigenvalue", x: 3000, y: 0 });
    assert.equal(r.body.card.parentId, "a");
    assert.equal(r.body.card.selection, "eigenvalue");
    assert.equal((await s.api("POST", "/api/canvases/desk0001/descend", { parentId: "a", selection: "  ", x: 0, y: 0 })).status, 400);
    assert.equal((await s.api("POST", "/api/canvases/desk0001/descend", { parentId: "ghost", selection: "x", x: 0, y: 0 })).status, 404);
  });
});

describe("F-DESCEND: a person, place or event is explained as its role", () => {
  test("selecting a name frames the card as that thing's part in what the page is about", async () => {
    llm.reset();
    llm.on(/./, "{}");
    const role = "Slobodan Milošević's role in the breakup of Yugoslavia";
    llm.on(/IN THAT SENTENCE/, { concept: role, searchQuery: "Milosevic breakup of Yugoslavia", register: "term", means: "" });
    const r = await s.api("POST", "/api/canvases/desk0001/descend", { parentId: "a", selection: "Slobodan Milošević", context: "", x: 3000, y: 2000 });
    const id = r.body.card.id;
    const card = await until(async () => {
      const c = ((await s.api("GET", "/api/canvases/desk0001")).body as CanvasState).items.find((i) => i.id === id) as CardItem;
      return c?.subject === role ? c : undefined;
    }, 10000, "the framed subject");
    assert.equal(card.selection, "Slobodan Milošević", "what was selected is still shown as selected");
    const resolve = llm.asked.find((a) => /IN THAT SENTENCE/.test(a.system))!;
    assert.match(resolve.system, /its role there/, "the prompt asks for the role, not the bare name");
    await s.api("POST", "/api/canvases/desk0001/hide", { ids: [id] });
  });
});

describe("F-RELATE: ask how two things are related", () => {
  test("a relation card between them, which depends on both", async () => {
    llm.reset();
    llm.on(/./, "{}");
    const r = await s.api("POST", "/api/canvases/desk0001/relate", { a: "a", b: "d", x: 500, y: 1000 });
    assert.deepEqual(r.body.card.relates, ["a", "d"]);
    assert.equal(r.body.card.subject, "Eigenvectors ⟷ Unrelated");
    assert.equal((await s.api("POST", "/api/canvases/desk0001/relate", { a: "a", b: "a", x: 0, y: 0 })).status, 400);
    const hidden = (await s.api("POST", "/api/canvases/desk0001/hide", { ids: ["d"] })).body.ids;
    assert.ok(hidden.includes(r.body.card.id), "removing either side removes the relation");
    await s.api("POST", "/api/canvases/desk0001/show", { ids: hidden });
  });
});

describe("F-SETTINGS: your models, your sources", () => {
  // Without ADMIN_PASSWORD, the server makes one on first start and keeps it beside the data.
  let cookie = "";
  const admin = (method: string, p: string, json?: unknown) => s.api(method, p, json, { cookie });

  test("F-ADMIN: without the administrator password, nobody sees or changes the models and keys", async () => {
    const file = path.join(env.LIBRARIAN_DATA, "admin-password");
    assert.equal(statSync(file).mode & 0o077, 0, "only its owner can read the password file");
    assert.equal((await s.api("GET", "/api/me")).body.user.admin, false);
    assert.equal((await s.api("GET", "/api/config")).status, 403);
    assert.equal((await s.api("PUT", "/api/config", { llm: { baseUrl: "http://evil.example" } })).status, 403);
    assert.equal((await s.api("GET", "/api/models/llm")).status, 403);
    assert.equal((await s.api("POST", "/api/test/llm")).status, 403);
    assert.equal((await s.api("POST", "/api/admin/unlock", { password: "guess" })).status, 403);
    const r = await s.api("POST", "/api/admin/unlock", { password: readFileSync(file, "utf8").trim() });
    assert.equal(r.status, 200);
    cookie = r.headers.getSetCookie()[0].split(";")[0];
    assert.equal((await admin("GET", "/api/me")).body.user.admin, true);
  });

  test("keys never reach the browser", async () => {
    const c = (await admin("GET", "/api/config")).body;
    assert.equal(c.llm.model, "fake-model");
    assert.equal(c.llm.hasKey, true);
    assert.ok(!JSON.stringify(c).includes("sk-test-secret-1234"));
  });

  test("models are listed from the endpoint, and the endpoint can be tested", async () => {
    assert.deepEqual((await admin("GET", "/api/models/llm")).body, { models: ["fake-model"] });
    assert.equal((await admin("GET", "/api/models/other")).status, 404);
    llm.on(/./, "OK");
    const t = (await admin("POST", "/api/test/llm")).body;
    assert.equal(t.ok, true, JSON.stringify(t));
  });

  test("changing a setting keeps the key unless a new one is given", async () => {
    const r = (await admin("PUT", "/api/config", { llm: { timeoutSeconds: 33 } })).body;
    assert.equal(r.llm.timeoutSeconds, 33);
    assert.equal(r.llm.hasKey, true);
  });

  test("F-ADMIN: changing the password locks out browsers that had the old one", async () => {
    const other = (await s.api("POST", "/api/admin/unlock", { password: readFileSync(path.join(env.LIBRARIAN_DATA, "admin-password"), "utf8").trim() })).headers.getSetCookie()[0].split(";")[0];
    assert.equal((await admin("PUT", "/api/admin/password", { password: "short" })).status, 400);
    const r = await admin("PUT", "/api/admin/password", { password: "a-new-password-here" });
    assert.equal(r.status, 200);
    cookie = r.headers.getSetCookie()[0].split(";")[0];
    assert.equal((await admin("GET", "/api/config")).status, 200, "the browser that changed it stays unlocked");
    assert.equal((await s.api("GET", "/api/config", undefined, { cookie: other })).status, 403);
    assert.equal(readFileSync(path.join(env.LIBRARIAN_DATA, "admin-password"), "utf8").trim(), "a-new-password-here");
    const locked = (await admin("POST", "/api/admin/lock")).headers.getSetCookie()[0];
    assert.match(locked, /Max-Age=0/);
  });
});

describe("serving the app", () => {
  test("/c/<id> gets the page, and unknown API paths are 404s", async () => {
    // Needs a build (npm test builds first).
    if (existsSync(path.resolve(import.meta.dirname, "../../dist/index.html"))) {
      const page = await fetch(`${s.url}/c/desk0001`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /id="root"/);
    }
    assert.equal((await s.api("GET", "/api/nothing-here")).status, 404);
  });

  test("/api/me says accounts are off and which speech the server has", async () => {
    const me = (await s.api("GET", "/api/me")).body;
    assert.equal(me.accounts, false);
    assert.deepEqual(me.speech, { tts: false, stt: false });
  });
});
