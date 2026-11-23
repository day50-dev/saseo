// API server: holds keys and proxies every external call, so keys never reach the browser.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono, type Next } from "hono";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { CARD_WIDTH, EXTENSION_SHAPES, type NotebookCell, substantive, type Extension, MOMENT_WIDTH, VIDEO_WIDTH, type CanvasInfo, SOURCE_WIDTH, type CanvasSummary, type CardItem, type ImageItem, type Move, type Rect, type RegionItem } from "../shared/canvas.ts";
import { type ConfigUpdate, SEARCHER_IDS, type SearcherId } from "../shared/providers.ts";
import { remember } from "./pagecache.ts";
import { pdfLink, servesPdf, slicePdf } from "./pdf.ts";
import { addReaderNote, assetPath, autoName, DATA_DIR, deleteCanvas, DEFAULT_NAME, nameFromItems, type CanvasStore, canvasStore, createCanvas, duplicateCanvas, getCanvasInfo, listCanvases, newId, saveAsset, updateCanvas } from "./canvas.ts";
import { AUTH_ON, auth, currentUser, initAuth, PROVIDERS, type User } from "./auth.ts";
import { allSightings } from "./curriculum.ts";
import { besideOf, callTurn, listen, type Pointing, say, SPEECH, type Turn } from "./call.ts";
import { around, captions, clock, copyPath, copyProgress, fetchCopy, frameAt, videoInfo, youtubeId } from "./video.ts";
import { CONFIG_PATH, diagramEndpoint, loadConfig, toPublic, updateConfig } from "./config.ts";
import { continueAfterAnswer, explainRegion, explainRelation, explainSelection, handleChat, extendPiece, findFor, makeObject, mapCourses, pointAt, readSource, refillSections, shapeSections } from "./explain.ts";
import { looksLikeLink } from "./pages.ts";
import { arxivPdf, parseArxivId, searchArxiv } from "./arxiv.ts";
import { listModels, runSearch, testLlm, testSystemOne } from "./providers.ts";

const app = new Hono<{ Variables: { user: User } }>();

// ---- Accounts ----
// Off unless LIBRARIAN_AUTH=on: a local copy has one user, who can do everything.

const authHandler = auth;
if (authHandler) app.on(["GET", "POST"], "/api/auth/*", (c) => authHandler.handler(c.req.raw));

app.get("/api/me", async (c) => c.json({ accounts: AUTH_ON, providers: PROVIDERS, user: await currentUser(c.req.raw), speech: { tts: Boolean(SPEECH.tts), stt: Boolean(SPEECH.stt) } }));

// Everything else under /api needs someone signed in, except images, which are named by their
// content hash and carry nothing private.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/me" || c.req.path.startsWith("/api/assets/") || c.req.path.startsWith("/api/videos/")) return next();
  const user = await currentUser(c.req.raw);
  if (!user) return c.json({ error: "sign in first" }, 401);
  c.set("user", user);
  return next();
});

// Models, keys and searchers are shared by everyone, so only admins see or change them.
const adminOnly = async (c: Context<{ Variables: { user: User } }>, next: Next) =>
  c.get("user").admin ? next() : c.json({ error: "only an admin can do that" }, 403);
app.use("/api/config", adminOnly);
app.use("/api/test/*", adminOnly);
app.use("/api/models/*", adminOnly);
app.use("/api/search", adminOnly);

/** Who may open a canvas: its owner; for one from before accounts, an admin; everyone, with accounts off. */
const canOpen = (info: CanvasInfo, user: User) => !AUTH_ON || info.owner === user.id || (!info.owner && user.admin);

/** The store for a canvas this user may open, or undefined, which every route answers as not found. */
async function canvasFor(c: Context<{ Variables: { user: User } }>): Promise<CanvasStore | undefined> {
  const info = await getCanvasInfo(c.req.param("cid") ?? "");
  if (!info || !canOpen(info, c.get("user"))) return undefined;
  return canvasStore(info.id);
}

app.get("/api/config", async (c) => c.json(toPublic(await loadConfig())));

app.put("/api/config", async (c) => {
  const update = (await c.req.json()) as ConfigUpdate;
  return c.json(toPublic(await updateConfig(update)));
});

app.post("/api/test/llm", async (c) => c.json(await testLlm((await loadConfig()).llm)));
app.post("/api/test/diagram", async (c) => c.json(await testLlm(diagramEndpoint(await loadConfig()))));

app.post("/api/test/systemone", async (c) =>
  c.json(await testSystemOne((await loadConfig()).systemOne)),
);

app.get("/api/models/:which", async (c) => {
  const which = c.req.param("which");
  if (which !== "llm" && which !== "systemOne" && which !== "diagram") return c.json({ error: "unknown endpoint" }, 404);
  try {
    const config = await loadConfig();
    return c.json({ models: await listModels(which === "diagram" ? diagramEndpoint(config) : config[which]) });
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

// ---- arXiv ----

app.get("/api/arxiv/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "q is required" }, 400);
  const sort = c.req.query("sort") === "date" ? "submittedDate" : "relevance";
  try {
    return c.json(await searchArxiv(q, { start: Number(c.req.query("start") ?? 0) || 0, max: 15, sort }));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// The PDF goes through the server: arXiv doesn't allow pages to fetch it directly, and the copy is cached.
app.get("/api/arxiv/pdf", async (c) => {
  const id = parseArxivId(c.req.query("id") ?? "");
  if (!id) return c.json({ error: "an arXiv id is required" }, 400);
  try {
    return c.body(new Uint8Array(await arxivPdf(id)), 200, { "Content-Type": "application/pdf", "Cache-Control": "private, max-age=86400" });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

// ---- Canvas ----

// The list says what each canvas holds and when it last changed, newest first.
app.get("/api/canvases", async (c) => {
  const user = c.get("user");
  const mine = (await listCanvases()).filter((info) => canOpen(info, user));
  const summaries: CanvasSummary[] = await Promise.all(
    mine.map(async (info) => {
      const state = await (await canvasStore(info.id))!.getState();
      const visible = state.items.filter((i) => !i.hidden);
      // Untitled ones are named after what's on them here too, not only when opened.
      const name = info.name === DEFAULT_NAME ? nameFromItems(state.items) : "";
      if (name) info = (await autoName(info.id, name)) ?? info;
      return {
        ...info,
        updatedAt: state.updatedAt ?? info.createdAt,
        cards: visible.filter((i) => i.kind === "card").length,
        pages: visible.filter((i) => i.kind === "image").length,
      };
    }),
  );
  return c.json(summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
});

app.post("/api/canvases", async (c) => {
  const { name } = (await c.req.json().catch(() => ({}))) as { name?: string };
  return c.json(await createCanvas(name ?? "", AUTH_ON ? c.get("user").id : undefined));
});

// Rename, or move into or out of the trash (deleting for good is DELETE, below).
app.patch("/api/canvases/:cid", async (c) => {
  const { name, trashed } = (await c.req.json()) as { name?: string; trashed?: boolean };
  if (!(await canvasFor(c))) return c.json({ error: "unknown canvas" }, 404);
  const info = await updateCanvas(c.req.param("cid"), { name, trashed: typeof trashed === "boolean" ? trashed : undefined });
  return info ? c.json(info) : c.json({ error: "unknown canvas" }, 404);
});

// Deletes a canvas for good. The client asks first; this can't be undone.
app.delete("/api/canvases/:cid", async (c) => {
  if (!(await canvasFor(c))) return c.json({ error: "unknown canvas" }, 404);
  return (await deleteCanvas(c.req.param("cid"))) ? c.json({ ok: true }) : c.json({ error: "unknown canvas" }, 404);
});

app.post("/api/canvases/:cid/duplicate", async (c) => {
  if (!(await canvasFor(c))) return c.json({ error: "unknown canvas" }, 404);
  const info = await duplicateCanvas(c.req.param("cid"), AUTH_ON ? c.get("user").id : undefined);
  return info ? c.json(info) : c.json({ error: "unknown canvas" }, 404);
});

app.get("/api/canvases/:cid", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const view = await store.view();
  let info = await getCanvasInfo(store.id);
  // Still "Untitled canvas": name it after what it was started from, once that has a title.
  if (info?.name === DEFAULT_NAME) {
    const name = nameFromItems(view.items);
    if (name) info = (await autoName(store.id, name)) ?? info;
  }
  return c.json({ ...info, ...view });
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
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const num = (k: string) => Number(body[k]);
  const asset = await saveAsset(Buffer.from(await file.arrayBuffer()), file.type);
  // A page added from arXiv says where it came from.
  let source: ImageItem["source"];
  try {
    const s = typeof body.source === "string" ? JSON.parse(body.source) : undefined;
    if (s?.kind === "arxiv" && parseArxivId(String(s.id))) {
      source = { kind: "arxiv", id: String(s.id), title: String(s.title ?? "").slice(0, 300), page: Number(s.page) || 1, url: `https://arxiv.org/abs/${s.id}` };
    }
  } catch {}
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
    ...(source ? { source } : {}),
  };
  if ([item.x, item.y, item.w, item.h, item.naturalW, item.naturalH].some((n) => !Number.isFinite(n))) {
    return c.json({ error: "x, y, w, h, naturalW and naturalH are required numbers" }, 400);
  }
  await store.add(item);
  return c.json(item);
});

app.post("/api/canvases/:cid/regions", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as {
    imageId: string;
    rect: Rect;
    card: { x: number; y: number };
    marked: string;
    crop: string;
    /** Words selected on a PDF page, exactly as the PDF has them. */
    text?: string;
  };
  const image = await store.findItem(body.imageId);
  if (image?.kind !== "image") return c.json({ error: "unknown image" }, 404);
  if (!body.marked?.startsWith("data:image/") || !body.crop?.startsWith("data:image/")) {
    return c.json({ error: "marked and crop must be image data URLs" }, 400);
  }
  const region: RegionItem = { kind: "region", id: newId(), imageId: image.id, rect: body.rect };
  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim().slice(0, 2000) : "";
  const card: CardItem = { kind: "card", id: newId(), parentId: region.id, x: body.card.x, y: body.card.y, w: CARD_WIDTH, stage: "reading", ...(text ? { selection: text } : {}) };
  await store.add(region);
  await store.add(card);
  void explainRegion(store, card.id, { marked: body.marked, crop: body.crop });
  return c.json({ region, card });
});

app.post("/api/canvases/:cid/descend", async (c) => {
  const store = await canvasFor(c);
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
// The course map gathered so far: every sighting of a concept in a course.
app.get("/api/curriculum", async (c) => c.json({ sightings: await allSightings() }));

// ---- A call with the librarian ----

// Audio in, words out. The canvas's subjects prime the recogniser with its vocabulary.
app.post("/api/speech/listen", async (c) => {
  if (!SPEECH.stt) return c.json({ error: "speech isn't set up on this server" }, 404);
  const cid = c.req.query("cid");
  const store = cid ? await canvasStore(cid) : undefined;
  const hint = store
    ? (await store.getState()).items
        .flatMap((i) => (i.kind === "card" && !i.hidden ? [i.subject ?? "", ...(i.sem?.terms ?? [])] : []))
        .filter(Boolean)
        .join(", ")
    : "";
  try {
    return c.json({ text: await listen(await c.req.arrayBuffer(), hint) });
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

// Words in, speech out.
app.post("/api/speech/say", async (c) => {
  if (!SPEECH.tts) return c.json({ error: "speech isn't set up on this server" }, 404);
  const { text } = (await c.req.json()) as { text?: string };
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);
  try {
    return c.body(await say(text.trim().slice(0, 2000)), 200, { "Content-Type": "audio/wav" });
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

// One turn of a call: what they said, what they're pointing at; the librarian answers and may act.
app.post("/api/canvases/:cid/call", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as { text?: string; pointing?: Pointing; history?: Turn[] };
  const text = body.text?.trim().slice(0, 2000);
  if (!text) return c.json({ error: "text is required" }, 400);
  // A stray syllable or noise gets no answer at all (the call goes on listening).
  if (!substantive(text)) return c.json({ say: "" });
  const turn = await callTurn(store, text, body.pointing ?? {}, Array.isArray(body.history) ? body.history.slice(-12) : [], {
    grow: async (card, ext) => {
      await store.edit(card.id, (now) => (now?.kind === "card" ? { ext: [...(now.ext ?? []), ext] } : null));
      void extendPiece(store, card.id, ext.id);
    },
    find: (near, kind, request, focus) => findFor(store, near, kind, request, focus),
    remove: async (ids) => {
      const hidden = await store.withDependents(ids);
      if (hidden.length) await store.record({ type: "hide", ids: hidden });
      return hidden;
    },
    descend: async (card, phrase) => {
      const cards = (await store.getState()).items.filter((i): i is CardItem => i.kind === "card" && !i.hidden);
      const at = besideOf(cards, card, (x) => x.h ?? (x.sem ? 900 : 300));
      const child: CardItem = { kind: "card", id: newId(), parentId: card.id, selection: phrase, ...at, w: CARD_WIDTH, stage: "reading", subject: phrase };
      await store.add(child);
      void explainSelection(store, child.id);
      return child;
    },
  }).catch((err) => {
    // Said briefly: the details go to the log, not out loud.
    console.warn("call turn failed:", err);
    return { say: "Sorry, I lost that one. Could you say it again?", did: undefined };
  });
  return c.json(turn);
});

// Restructures the whole of a linked page section by section, for page cards read before that existed.
app.post("/api/canvases/:cid/cards/:id/sections", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card" || card.origin?.kind !== "page" || !card.pageText) return c.json({ error: "not a read page" }, 409);
  if (!card.sections?.some((s) => s.status === "working")) void shapeSections(store, card.id);
  return c.json({ ok: true });
});

// Grows a shape from one piece of a card's diagram: one the reader picked, or the one their words call for.
app.post("/api/canvases/:cid/cards/:id/extend", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card" || !card.sem) return c.json({ error: "not a card with a diagram" }, 409);
  const body = (await c.req.json()) as { at?: string; shape?: string; ask?: string; focus?: string };
  const at = typeof body.at === "string" ? body.at.slice(0, 80) : "";
  const ask = typeof body.ask === "string" ? body.ask.trim().slice(0, 500) : "";
  const shape = EXTENSION_SHAPES.find((s) => s === body.shape) ?? (ask ? "aside" : undefined);
  if (!at || !shape) return c.json({ error: "a piece and a shape (or a question) are required" }, 400);
  const ext: Extension = {
    id: newId(),
    at,
    shape,
    ...(ask ? { ask } : {}),
    ...(typeof body.focus === "string" && body.focus.trim() ? { focus: body.focus.trim().slice(0, 200) } : {}),
    status: "working",
  };
  await store.edit(card.id, (now) => (now?.kind === "card" ? { ext: [...(now.ext ?? []), ext] } : null));
  void extendPiece(store, card.id, ext.id);
  return c.json({ ext });
});

// Takes a grown shape away, with everything grown from its pieces.
app.post("/api/canvases/:cid/cards/:id/extend/:extId/remove", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  const gone = new Set([c.req.param("extId")]);
  let taken: Extension[] = [];
  await store.edit(card.id, (now) => {
    if (now?.kind !== "card") return null;
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of now.ext ?? []) {
        const from = /^x([^.]+)\./.exec(e.at)?.[1];
        if (from && gone.has(from) && !gone.has(e.id)) {
          gone.add(e.id);
          grew = true;
        }
      }
    }
    taken = (now.ext ?? []).filter((e) => gone.has(e.id));
    return { ext: (now.ext ?? []).filter((e) => !gone.has(e.id)) };
  });
  // A card found for one of them (its videos) goes with it.
  const made = await store.withDependents(taken.flatMap((e) => (e.made ? [e.made] : [])));
  if (made.length) await store.record({ type: "hide", ids: made });
  return c.json({ removed: [...gone], taken });
});

// Brings back what an object card held before a message asked for something else (and swaps, so it can go again).
app.post("/api/canvases/:cid/cards/:id/object/back", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card" || !card.replaced) return c.json({ error: "nothing to bring back" }, 409);
  const now = card.object ? { object: card.object, request: card.request, subject: card.subject } : undefined;
  await store.update(card.id, { object: card.replaced.object, request: card.replaced.request, subject: card.replaced.subject, stage: "done", replaced: now });
  return c.json({ ok: true });
});

// Puts grown shapes back as they were (undoing their removal); any still being grown carry on.
app.post("/api/canvases/:cid/cards/:id/extend/restore", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  const body = (await c.req.json()) as { ext?: Extension[] };
  const back = (Array.isArray(body.ext) ? body.ext : []).filter((e) => e && typeof e.id === "string" && typeof e.at === "string");
  let added: Extension[] = [];
  await store.edit(card.id, (now) => {
    if (now?.kind !== "card") return null;
    const have = new Set((now.ext ?? []).map((e) => e.id));
    added = back.filter((e) => !have.has(e.id));
    return { ext: [...(now.ext ?? []), ...added] };
  });
  for (const e of added) if (e.status === "working") void extendPiece(store, card.id, e.id);
  const made = added.flatMap((e) => (e.made ? [e.made] : []));
  if (made.length) await store.record({ type: "show", ids: made });
  return c.json({ ok: true });
});

// Looks up where a finished card's subject is taught, for cards written before the course map.
app.post("/api/canvases/:cid/cards/:id/courses", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card" || card.stage !== "done" || !card.sem) return c.json({ error: "not a finished card" }, 409);
  const subject = card.subject ?? card.origin?.title ?? "";
  const page = card.origin?.kind === "page" ? [{ n: 1, url: card.origin.url, title: card.origin.title, snippet: (card.pageText ?? "").slice(0, 600), searcher: "page" }] : [];
  if (subject) void mapCourses(store, card.id, subject, [...(card.sources ?? []), ...page]);
  else await store.update(card.id, { taught: [] });
  return c.json({ ok: true });
});

// Finds where on its page each piece of a finished card points, for cards written before that existed.
app.post("/api/canvases/:cid/cards/:id/look", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card" || card.stage !== "done" || !card.sem) return c.json({ error: "not a finished card" }, 409);
  if (card.looking !== "working") void pointAt(store, card.id);
  return c.json({ ok: true });
});

// Your edits to a notebook: its cells, as they are now.
app.put("/api/canvases/:cid/cards/:id/notebook", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { cells } = (await c.req.json()) as { cells?: NotebookCell[] };
  if (!Array.isArray(cells)) return c.json({ error: "cells is required" }, 400);
  const clean = cells
    .filter((x) => x && typeof x.source === "string" && typeof x.id === "string")
    .slice(0, 500)
    .map((x) => ({ id: x.id.slice(0, 40), kind: x.kind === "markdown" ? ("markdown" as const) : ("code" as const), source: x.source.slice(0, 100_000) }));
  const done = await store.edit(c.req.param("id"), (now) =>
    now?.kind === "card" && now.object?.type === "notebook" ? { object: { ...now.object, cells: clean } } : null,
  );
  return c.json({ ok: true, done });
});

app.post("/api/canvases/:cid/cards/:id/retry", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  // A linked page can be read again at any time (it may have changed); anything else only after failing.
  const reread = card.origin?.kind === "page" && card.stage === "done";
  if (card.stage !== "failed" && !reread) return c.json({ error: "only a failed card can be retried" }, 409);
  const parent = await store.findItem(card.parentId);
  if (card.origin?.kind === "page") {
    await store.update(card.id, { stage: "reading", error: "" });
    // "Read again" fetches the page anew; a failed read may just retry from what's stored.
    void readSource(store, card.id, reread);
  } else if (card.objectKind) {
    await store.update(card.id, { stage: "reading", error: "" });
    void makeObject(store, card.id);
  } else if (card.relates) {
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

// The reader answers the librarian's question (or skips it), and the explanation carries on.
// The answer is kept for the canvas, so later cards are pitched to it too.
app.post("/api/canvases/:cid/cards/:id/answer", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card" || card.stage !== "asking" || !card.clarify) return c.json({ error: "that card isn't waiting for an answer" }, 409);
  const body = (await c.req.json().catch(() => ({}))) as { answer?: unknown };
  const answer = typeof body.answer === "string" ? body.answer.trim().slice(0, 500) : "";
  await store.update(card.id, { stage: "searching", clarify: { ...card.clarify, answer } });
  await addReaderNote(store.id, { q: card.clarify.question, a: answer });
  void continueAfterAnswer(store, card.id);
  return c.json({ ok: true });
});

app.post("/api/canvases/:cid/move", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { moves } = (await c.req.json()) as { moves: Move[] };
  if (!Array.isArray(moves) || !moves.length) return c.json({ error: "moves is required" }, 400);
  const result = await store.moveItems(moves);
  return result.ok ? c.json(result) : c.json(result, 409);
});

app.post("/api/canvases/:cid/collapse", async (c) => {
  const store = await canvasFor(c);
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
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as { a: string; b: string; x: number; y: number };
  const [a, b] = await Promise.all([store.findItem(body.a), store.findItem(body.b)]);
  // Either side may be a card or a whole image (a slide).
  const relatable = (i: typeof a) => i?.kind === "card" || i?.kind === "image";
  if (!a || !b || !relatable(a) || !relatable(b) || a.id === b.id) {
    return c.json({ error: "two different cards or images are required" }, 400);
  }
  const label = (i: NonNullable<typeof a>) => (i.kind === "card" ? (i.subject ?? "this") : i.kind === "image" ? (i.topic ?? i.name) : "this");
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
    subject: `${label(a)} ⟷ ${label(b)}`,
  };
  await store.add(card);
  void explainRelation(store, card.id);
  return c.json({ card });
});

// A conversation held at a card: the question is recorded, and the answer arrives in the log.
app.post("/api/canvases/:cid/cards/:id/chat", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const card = await store.findItem(c.req.param("id"));
  if (card?.kind !== "card") return c.json({ error: "unknown card" }, 404);
  if (card.chatPending) return c.json({ error: "still answering the last message" }, 409);
  const { text } = (await c.req.json()) as { text?: string };
  const clean = typeof text === "string" ? text.trim().slice(0, 4000) : "";
  if (!clean) return c.json({ error: "text is required" }, 400);
  await store.record({ type: "chat", id: card.id, message: { role: "user", text: clean, at: new Date().toISOString() } });
  await store.update(card.id, { chatPending: true });
  void handleChat(store, card.id);
  return c.json({ ok: true });
});

app.post("/api/canvases/:cid/z", async (c) => {
  const store = await canvasFor(c);
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

// Start from a link (the page is read) or a statement (explained straight away).
app.post("/api/canvases/:cid/sources", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as { input?: string; x?: number; y?: number };
  const input = typeof body.input === "string" ? body.input.trim().slice(0, 2000) : "";
  if (!input) return c.json({ error: "a link or a statement is required" }, 400);
  if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) return c.json({ error: "x and y are required" }, 400);
  const at = { x: Math.round(body.x!), y: Math.round(body.y!) };
  // A YouTube link is a lecture to watch here, stopping where it loses you.
  const yt = youtubeId(input);
  if (yt) {
    const info = await videoInfo(yt);
    let asset = "";
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) asset = await saveAsset(Buffer.from(await r.arrayBuffer()), "image/jpeg");
    } catch {}
    const video: ImageItem = {
      kind: "image",
      id: newId(),
      asset,
      name: info.title,
      ...at,
      w: VIDEO_WIDTH,
      h: Math.round((VIDEO_WIDTH * 9) / 16),
      naturalW: 1280,
      naturalH: 720,
      topic: info.title,
      pageText: [info.title, info.channel && `by ${info.channel}`, info.description].filter(Boolean).join("\n"),
      video: { videoId: yt, title: info.title, channel: info.channel, duration: info.duration, embeddable: info.embeddable },
    };
    await store.add(video);
    // Its uploader doesn't allow playing it elsewhere: fetch our own copy to play here.
    if (!info.embeddable) void hostVideo(store, video.id, "not-embeddable");
    void captions(yt).catch(() => []); // fetched ahead, so the first moment is quick
    return c.json({ image: video });
  }
  // A PDF (an arXiv paper, or any .pdf) becomes its pages, each a single-page PDF, ten to a row.
  const pdf = pdfLink(input) ?? (looksLikeLink(input) && (await servesPdf(input)) ? { url: input } : null);
  if (pdf) {
    try {
      const sliced = await slicePdf(pdf);
      const PER_ROW = 10;
      const GAP_X = 40;
      const GAP_Y = 80;
      const width = 480;
      const images: ImageItem[] = [];
      let rowTop = at.y;
      for (let i = 0; i < sliced.pages.length; i += PER_ROW) {
        const row = sliced.pages.slice(i, i + PER_ROW);
        let x = at.x;
        let tallest = 0;
        for (const p of row) {
          const h = Math.round((p.h * width) / p.w);
          const img: ImageItem = {
            kind: "image",
            id: newId(),
            asset: p.png,
            name: `${sliced.title} p.${p.n}`,
            x,
            y: rowTop,
            w: width,
            h,
            naturalW: p.w,
            naturalH: p.h,
            pageText: p.text || undefined,
            pdf: { asset: p.pdf, page: p.n, pages: sliced.total, url: pdf.arxiv ? `https://arxiv.org/pdf/${pdf.arxiv}` : pdf.url, title: sliced.title },
          };
          await store.add(img);
          images.push(img);
          x += width + GAP_X;
          tallest = Math.max(tallest, h);
        }
        rowTop += tallest + GAP_Y;
      }
      return c.json({ image: images[0], images, total: sliced.total });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  }
  if (looksLikeLink(input)) {
    const card: CardItem = { kind: "card", id: newId(), parentId: "", origin: { kind: "page", url: input, title: input }, ...at, w: SOURCE_WIDTH, stage: "reading", subject: input };
    await store.add(card);
    void readSource(store, card.id);
    return c.json({ card });
  }
  // A statement is what you want to understand, so it is explained right away, beside it.
  const note: CardItem = { kind: "card", id: newId(), parentId: "", origin: { kind: "note", title: input }, ...at, w: CARD_WIDTH, stage: "done", subject: input, pageText: input };
  const answer: CardItem = { kind: "card", id: newId(), parentId: note.id, selection: input, x: at.x + CARD_WIDTH + 64, y: at.y, w: CARD_WIDTH, stage: "reading", subject: input };
  await store.add(note);
  await store.add(answer);
  void explainSelection(store, answer.id);
  return c.json({ card: note, answer });
});

/** Fetches a copy of a video to play here, recording progress on its item so the canvas can show it. */
async function hostVideo(store: CanvasStore, itemId: string, why?: "not-embeddable" | "player-refused") {
  const item = await store.findItem(itemId);
  if (item?.kind !== "image" || !item.video) return;
  await store.update(itemId, { video: { ...item.video, hosted: "downloading", hostError: undefined, why: why ?? item.video.why } });
  let hosted: "ready" | "failed" = "ready";
  let hostError: string | undefined;
  try {
    await fetchCopy(item.video.videoId);
  } catch (err) {
    hosted = "failed";
    hostError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
  const now = await store.findItem(itemId);
  if (now?.kind === "image" && now.video) await store.update(itemId, { video: { ...now.video, hosted, hostError } });
}

// The player found it can't be embedded after all, or a fetch failed and is asked for again.
app.post("/api/canvases/:cid/videos/:id/host", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const item = await store.findItem(c.req.param("id"));
  if (item?.kind !== "image" || !item.video) return c.json({ error: "unknown video" }, 404);
  if (item.video.hosted !== "downloading" && item.video.hosted !== "ready")
    void hostVideo(store, item.id, item.video.embeddable === false ? "not-embeddable" : "player-refused");
  return c.json({ ok: true });
});

// How the download of a video's copy is going.
app.get("/api/video-progress/:id", (c) => c.json(copyProgress(c.req.param("id")) ?? { phase: "starting" }));

// Our copy of a video, with ranges so the player can seek.
app.get("/api/videos/:file", async (c) => {
  const m = /^([A-Za-z0-9_-]{11})\.mp4$/.exec(c.req.param("file"));
  if (!m) return c.notFound();
  return sendRanged(c, copyPath(m[1]), "video/mp4");
});

// The explainer video about Librarian itself (made with docs/explainer/), if this server has one.
app.get("/explainer.mp4", (c) => sendRanged(c, path.join(DATA_DIR, "explainer.mp4"), "video/mp4"));
app.get("/explainer.jpg", (c) => sendRanged(c, path.join(DATA_DIR, "explainer.jpg"), "image/jpeg"));

/** Serves a file with byte ranges, so a player can seek. */
async function sendRanged(c: Context, file: string, type: string): Promise<Response> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return c.notFound();
  }
  const range = /bytes=(\d*)-(\d*)/.exec(c.req.header("range") ?? "");
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" };
  if (!range) {
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
    status: 206,
    headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` },
  });
}

// Stopping a video: the frame at that moment lands on the canvas like a slide, and below it a
// card with what was said around it. Box the frame or select the words to go further down.
app.post("/api/canvases/:cid/videos/:id/moments", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const video = await store.findItem(c.req.param("id"));
  if (video?.kind !== "image" || !video.video) return c.json({ error: "unknown video" }, 404);
  const body = (await c.req.json()) as { t?: number; x?: number; y?: number };
  const t = Number(body.t);
  if (!Number.isFinite(t) || !Number.isFinite(body.x) || !Number.isFinite(body.y)) return c.json({ error: "t, x and y are required" }, 400);
  const { videoId, title } = video.video;
  let frame: Awaited<ReturnType<typeof frameAt>>;
  let caps: Awaited<ReturnType<typeof captions>>;
  try {
    [frame, caps] = await Promise.all([frameAt(videoId, t), captions(videoId).catch(() => [])]);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
  const asset = await saveAsset(frame.jpeg, "image/jpeg");
  const transcript = around(caps, t);
  const w = MOMENT_WIDTH;
  const h = Math.round((w * frame.h) / frame.w);
  const image: ImageItem = {
    kind: "image",
    id: newId(),
    asset,
    name: `${clock(t)} · ${title}`,
    x: Math.round(body.x!),
    y: Math.round(body.y!),
    w,
    h,
    naturalW: frame.w,
    naturalH: frame.h,
    topic: title,
    moment: { videoImageId: video.id, videoId, t, title },
    transcript,
  };
  await store.add(image);
  let card: CardItem | undefined;
  if (transcript) {
    card = {
      kind: "card",
      id: newId(),
      parentId: image.id,
      origin: { kind: "note", title: transcript },
      x: image.x,
      y: image.y + h + 48,
      w: w,
      stage: "done",
      subject: `What was said at ${clock(t)}`,
      pageText: transcript,
    };
    await store.add(card);
  }
  return c.json({ image, card });
});

// Removing is a hide event: the log keeps everything, so any removal can be undone.
app.post("/api/canvases/:cid/hide", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { ids } = (await c.req.json()) as { ids: string[] };
  const hidden = await store.withDependents(Array.isArray(ids) ? ids : []);
  if (hidden.length) await store.record({ type: "hide", ids: hidden });
  return c.json({ ids: hidden });
});

app.post("/api/canvases/:cid/show", async (c) => {
  const store = await canvasFor(c);
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

await initAuth();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`librarian API on http://127.0.0.1:${port} (config: ${CONFIG_PATH}; accounts ${AUTH_ON ? "on" : "off"})`);
});

// Every page any canvas has read goes into the page store, and then every canvas takes from it
// the sections it's missing. Loading a canvas also resumes whatever a restart interrupted there.
void (async () => {
  const pages: [CanvasStore, string][] = [];
  for (const info of await listCanvases()) {
    const store = await canvasStore(info.id).catch(() => undefined);
    const items = store ? (await store.getState().catch(() => null))?.items ?? [] : [];
    for (const c of items) {
      if (c.kind !== "card" || c.origin?.kind !== "page") continue;
      await remember(c).catch(() => {});
      pages.push([store!, c.id]);
    }
  }
  for (const [store, id] of pages) await refillSections(store, id).catch(() => {});
  if (pages.length) console.log(`page store: ${pages.length} linked pages remembered`);
})();
