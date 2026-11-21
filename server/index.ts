// API server: holds keys and proxies every external call, so keys never reach the browser.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { CARD_WIDTH, type CardItem, type ImageItem, type Move, type Rect, type RegionItem } from "../shared/canvas.ts";
import { type ConfigUpdate, SEARCHER_IDS, type SearcherId } from "../shared/providers.ts";
import { assetPath, canvasStore, createCanvas, getCanvasInfo, listCanvases, newId, renameCanvas, saveAsset } from "./canvas.ts";
import { CONFIG_PATH, loadConfig, toPublic, updateConfig } from "./config.ts";
import { chatAbout, explainRegion, explainRelation, explainSelection } from "./explain.ts";
import { listModels, runSearch, testLlm, testSystemOne } from "./providers.ts";

const app = new Hono();

app.get("/api/config", async (c) => c.json(toPublic(await loadConfig())));

app.put("/api/config", async (c) => {
  const update = (await c.req.json()) as ConfigUpdate;
  return c.json(toPublic(await updateConfig(update)));
});

app.post("/api/test/llm", async (c) => c.json(await testLlm((await loadConfig()).llm)));

app.post("/api/test/systemone", async (c) =>
  c.json(await testSystemOne((await loadConfig()).systemOne)),
);

app.get("/api/models/:which", async (c) => {
  const which = c.req.param("which");
  if (which !== "llm" && which !== "systemOne") return c.json({ error: "unknown endpoint" }, 404);
  try {
    return c.json({ models: await listModels((await loadConfig())[which]) });
  } catch (err) {
    return c.json({ models: [], error: (err as Error).message });
  }
});

app.post("/api/search", async (c) => {
  const body = (await c.req.json()) as { query?: string; searchers?: string[]; count?: number };
  const query = body.query?.trim();
  if (!query) return c.json({ error: "query is required" }, 400);
  const config = await loadConfig();
  const ids = (body.searchers ?? SEARCHER_IDS.filter((id) => config.searchers[id].enabled)).filter(
    (id): id is SearcherId => (SEARCHER_IDS as readonly string[]).includes(id),
  );
  const count = Math.min(Math.max(body.count ?? 5, 1), 20);
  return c.json(await runSearch(config, query, ids, count));
});

// ---- Canvas ----

app.get("/api/canvases", async (c) => c.json(await listCanvases()));

app.post("/api/canvases", async (c) => {
  const { name } = (await c.req.json().catch(() => ({}))) as { name?: string };
  return c.json(await createCanvas(name ?? ""));
});

app.patch("/api/canvases/:cid", async (c) => {
  const { name } = (await c.req.json()) as { name?: string };
  const info = await renameCanvas(c.req.param("cid"), name ?? "");
  return info ? c.json(info) : c.json({ error: "unknown canvas" }, 404);
});

app.get("/api/canvases/:cid", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  return c.json({ ...(await getCanvasInfo(store.id)), ...(await store.getState()) });
});

app.get("/api/assets/:name", async (c) => {
  const found = assetPath(c.req.param("name"));
  if (!found) return c.notFound();
  try {
    const bytes = await readFile(found.file);
    return c.body(bytes, 200, { "Content-Type": found.mime, "Cache-Control": "public, max-age=31536000, immutable" });
  } catch {
    return c.notFound();
  }
});

app.post("/api/canvases/:cid/images", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const num = (k: string) => Number(body[k]);
  const asset = await saveAsset(Buffer.from(await file.arrayBuffer()), file.type);
  const item: ImageItem = {
    kind: "image",
    id: newId(),
    asset,
    name: file.name || "image",
    x: num("x"),
    y: num("y"),
    w: num("w"),
    h: num("h"),
    naturalW: num("naturalW"),
    naturalH: num("naturalH"),
  };
  if ([item.x, item.y, item.w, item.h, item.naturalW, item.naturalH].some((n) => !Number.isFinite(n))) {
    return c.json({ error: "x, y, w, h, naturalW and naturalH are required numbers" }, 400);
  }
  await store.add(item);
  return c.json(item);
});

app.post("/api/canvases/:cid/regions", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as {
    imageId: string;
    rect: Rect;
    card: { x: number; y: number };
    marked: string;
    crop: string;
  };
  const image = await store.findItem(body.imageId);
  if (image?.kind !== "image") return c.json({ error: "unknown image" }, 404);
  if (!body.marked?.startsWith("data:image/") || !body.crop?.startsWith("data:image/")) {
    return c.json({ error: "marked and crop must be image data URLs" }, 400);
  }
  const region: RegionItem = { kind: "region", id: newId(), imageId: image.id, rect: body.rect };
  const card: CardItem = { kind: "card", id: newId(), parentId: region.id, x: body.card.x, y: body.card.y, w: CARD_WIDTH, stage: "reading" };
  await store.add(region);
  await store.add(card);
  void explainRegion(store, card.id, { marked: body.marked, crop: body.crop });
  return c.json({ region, card });
});

app.post("/api/canvases/:cid/descend", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as { parentId: string; selection: string; context?: string; x: number; y: number };
  const parent = await store.findItem(body.parentId);
  if (parent?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  const selection = body.selection?.trim().slice(0, 300);
  if (!selection) return c.json({ error: "selection is required" }, 400);
  const context = typeof body.context === "string" ? body.context.trim().slice(0, 500) : undefined;
  const card: CardItem = { kind: "card", id: newId(), parentId: parent.id, selection, context, x: body.x, y: body.y, w: CARD_WIDTH, stage: "reading", subject: selection };
  await store.add(card);
  void explainSelection(store, card.id);
  return c.json({ card });
});

// Runs a failed card again in place. A card from a box needs the images re-sent, since
// only the box's position is stored, not the pixels sent to the model.
app.post("/api/canvases/:cid/cards/:id/retry", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  if (card.stage !== "failed") return c.json({ error: "only a failed card can be retried" }, 409);
  const parent = await store.findItem(card.parentId);
  if (card.relates) {
    await store.update(card.id, { stage: "reading", error: "" });
    void explainRelation(store, card.id);
  } else if (parent?.kind === "region") {
    const body = (await c.req.json().catch(() => ({}))) as { marked?: string; crop?: string };
    if (!body.marked?.startsWith("data:image/") || !body.crop?.startsWith("data:image/")) {
      return c.json({ error: "marked and crop must be image data URLs" }, 400);
    }
    await store.update(card.id, { stage: "reading", error: "" });
    void explainRegion(store, card.id, { marked: body.marked, crop: body.crop });
  } else {
    await store.update(card.id, { stage: "reading", error: "" });
    void explainSelection(store, card.id);
  }
  return c.json({ ok: true });
});

app.post("/api/canvases/:cid/move", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { moves } = (await c.req.json()) as { moves: Move[] };
  if (!Array.isArray(moves) || !moves.length) return c.json({ error: "moves is required" }, 400);
  const result = await store.moveItems(moves);
  return result.ok ? c.json(result) : c.json(result, 409);
});

app.post("/api/canvases/:cid/collapse", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { ids, collapsed } = (await c.req.json()) as { ids: string[]; collapsed: boolean };
  const known = new Map((await store.getState()).items.map((i) => [i.id, i]));
  const valid = (Array.isArray(ids) ? ids : []).filter((id) => {
    const kind = known.get(id)?.kind;
    return kind === "card" || kind === "image";
  });
  if (!valid.length || typeof collapsed !== "boolean") return c.json({ error: "ids of cards or images, and collapsed: boolean" }, 400);
  await store.record({ type: "collapse", ids: valid, collapsed });
  return c.json({ ok: true });
});

// The learner asks how two things relate; a card between them finds out.
app.post("/api/canvases/:cid/relate", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as { a: string; b: string; x: number; y: number };
  const [a, b] = await Promise.all([store.findItem(body.a), store.findItem(body.b)]);
  if (a?.kind !== "card" || b?.kind !== "card" || a.id === b.id) return c.json({ error: "two different cards are required" }, 400);
  if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) return c.json({ error: "x and y are required" }, 400);
  const card: CardItem = {
    kind: "card",
    id: newId(),
    parentId: a.id,
    relates: [a.id, b.id],
    x: body.x,
    y: body.y,
    w: CARD_WIDTH,
    stage: "reading",
    subject: `${a.subject ?? "this"} ⟷ ${b.subject ?? "that"}`,
  };
  await store.add(card);
  void explainRelation(store, card.id);
  return c.json({ card });
});

// A conversation held at a card: the question is recorded, and the answer arrives in the log.
app.post("/api/canvases/:cid/cards/:id/chat", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  if (card.chatPending) return c.json({ error: "still answering the last message" }, 409);
  const { text } = (await c.req.json()) as { text?: string };
  const clean = typeof text === "string" ? text.trim().slice(0, 4000) : "";
  if (!clean) return c.json({ error: "text is required" }, 400);
  await store.record({ type: "chat", id: card.id, message: { role: "user", text: clean, at: new Date().toISOString() } });
  await store.update(card.id, { chatPending: true });
  void chatAbout(store, card.id);
  return c.json({ ok: true });
});

app.post("/api/canvases/:cid/z", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { order } = (await c.req.json()) as { order: { id: string; z: number }[] };
  const known = new Map((await store.getState()).items.map((i) => [i.id, i.kind]));
  const valid = (Array.isArray(order) ? order : []).filter(
    (o) => Number.isFinite(o.z) && (known.get(o.id) === "card" || known.get(o.id) === "image"),
  );
  if (!valid.length) return c.json({ error: "order of cards or images is required" }, 400);
  await store.record({ type: "z", order: valid.map((o) => ({ id: o.id, z: Math.round(o.z) })) });
  return c.json({ ok: true });
});

// Removing is a hide event: the log keeps everything, so any removal can be undone.
app.post("/api/canvases/:cid/hide", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { ids } = (await c.req.json()) as { ids: string[] };
  const hidden = await store.withDependents(Array.isArray(ids) ? ids : []);
  if (hidden.length) await store.record({ type: "hide", ids: hidden });
  return c.json({ ids: hidden });
});

app.post("/api/canvases/:cid/show", async (c) => {
  const store = await canvasStore(c.req.param("cid"));
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { ids } = (await c.req.json()) as { ids: string[] };
  const known = new Set((await store.getState()).items.map((i) => i.id));
  const shown = (Array.isArray(ids) ? ids : []).filter((id) => known.has(id));
  if (shown.length) await store.record({ type: "show", ids: shown });
  return c.json({ ids: shown });
});

// In production, serve the built panel too; app paths like /c/<id> get the page and route there.
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/")) return c.notFound();
  try {
    return c.html(await readFile("./dist/index.html", "utf8"));
  } catch {
    return c.notFound();
  }
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`librarian API on http://127.0.0.1:${port} (config: ${CONFIG_PATH})`);
});
