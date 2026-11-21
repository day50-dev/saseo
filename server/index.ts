// API server: holds keys and proxies every external call, so keys never reach the browser.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { CARD_WIDTH, type CardItem, type ImageItem, type Rect, type RegionItem } from "../shared/canvas.ts";
import { type ConfigUpdate, SEARCHER_IDS, type SearcherId } from "../shared/providers.ts";
import { add, assetPath, findItem, getState, newId, record, saveAsset, update, withDependents } from "./canvas.ts";
import { CONFIG_PATH, loadConfig, toPublic, updateConfig } from "./config.ts";
import { explainRegion, explainSelection } from "./explain.ts";
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

app.get("/api/canvas", async (c) => c.json(await getState()));

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

app.post("/api/canvas/images", async (c) => {
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
  await add(item);
  return c.json(item);
});

app.post("/api/canvas/regions", async (c) => {
  const body = (await c.req.json()) as {
    imageId: string;
    rect: Rect;
    card: { x: number; y: number };
    marked: string;
    crop: string;
  };
  const image = await findItem(body.imageId);
  if (image?.kind !== "image") return c.json({ error: "unknown image" }, 404);
  if (!body.marked?.startsWith("data:image/") || !body.crop?.startsWith("data:image/")) {
    return c.json({ error: "marked and crop must be image data URLs" }, 400);
  }
  const region: RegionItem = { kind: "region", id: newId(), imageId: image.id, rect: body.rect };
  const card: CardItem = { kind: "card", id: newId(), parentId: region.id, x: body.card.x, y: body.card.y, w: CARD_WIDTH, stage: "reading" };
  await add(region);
  await add(card);
  void explainRegion(card.id, { marked: body.marked, crop: body.crop });
  return c.json({ region, card });
});

app.post("/api/canvas/descend", async (c) => {
  const body = (await c.req.json()) as { parentId: string; selection: string; x: number; y: number };
  const parent = await findItem(body.parentId);
  if (parent?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  const selection = body.selection?.trim().slice(0, 300);
  if (!selection) return c.json({ error: "selection is required" }, 400);
  const card: CardItem = { kind: "card", id: newId(), parentId: parent.id, selection, x: body.x, y: body.y, w: CARD_WIDTH, stage: "searching", subject: selection };
  await add(card);
  void explainSelection(card.id);
  return c.json({ card });
});

// Runs a failed card again in place. A card from a box needs the images re-sent, since
// only the box's position is stored, not the pixels sent to the model.
app.post("/api/canvas/cards/:id/retry", async (c) => {
  const card = await findItem(c.req.param("id"));
  if (card?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  if (card.stage !== "failed") return c.json({ error: "only a failed card can be retried" }, 409);
  const parent = await findItem(card.parentId);
  if (parent?.kind === "region") {
    const body = (await c.req.json().catch(() => ({}))) as { marked?: string; crop?: string };
    if (!body.marked?.startsWith("data:image/") || !body.crop?.startsWith("data:image/")) {
      return c.json({ error: "marked and crop must be image data URLs" }, 400);
    }
    await update(card.id, { stage: "reading" });
    void explainRegion(card.id, { marked: body.marked, crop: body.crop });
  } else {
    await update(card.id, { stage: "searching" });
    void explainSelection(card.id);
  }
  return c.json({ ok: true });
});

// Removing is a hide event: the log keeps everything, so any removal can be undone.
app.post("/api/canvas/hide", async (c) => {
  const { ids } = (await c.req.json()) as { ids: string[] };
  const hidden = await withDependents(Array.isArray(ids) ? ids : []);
  if (hidden.length) await record({ type: "hide", ids: hidden });
  return c.json({ ids: hidden });
});

app.post("/api/canvas/show", async (c) => {
  const { ids } = (await c.req.json()) as { ids: string[] };
  const known = new Set((await getState()).items.map((i) => i.id));
  const shown = (Array.isArray(ids) ? ids : []).filter((id) => known.has(id));
  if (shown.length) await record({ type: "show", ids: shown });
  return c.json({ ids: shown });
});

// In production, serve the built panel too.
app.use("/*", serveStatic({ root: "./dist" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`semshapes API on http://127.0.0.1:${port} (config: ${CONFIG_PATH})`);
});
