// API server: holds keys and proxies every external call, so keys never reach the browser.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono, type Next } from "hono";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { CARD_WIDTH, EXTENSION_SHAPES, type NotebookCell, substantive, type Extension, MOMENT_WIDTH, VIDEO_WIDTH, type CanvasInfo, SOURCE_WIDTH, type CanvasSummary, type Role, type CardItem, type Goal, type ImageItem, type NoteItem, type Move, type Rect, type RegionItem } from "../shared/canvas.ts";
import { type ConfigUpdate, SEARCHER_IDS, type SearcherId } from "../shared/providers.ts";
import { remember } from "./pagecache.ts";
import { pdfLink, servesPdf, slicePdf } from "./pdf.ts";
import { actor, addReaderNote, transferCanvases, addShareLink, assetPath, autoName, changesSince, DATA_DIR, joinByLink, markSeen, removeMember, removeShareLink, roleOf, deleteCanvas, DEFAULT_NAME, nameFromItems, type CanvasStore, canvasStore, createCanvas, duplicateCanvas, preparedExamples, getCanvasInfo, listCanvases, newId, saveAsset, updateCanvas } from "./canvas.ts";
import { changePassword, lockedCookie, PASSWORD_FROM_ENV, unlock } from "./admin.ts";
import { AUTH_ON, auth, currentUser, initAuth, PROVIDERS, type User } from "./auth.ts";
import { allSightings } from "./curriculum.ts";
import { besideOf, type CallContext, callTurn, canSpeak, listen, type Pointing, say, SPEECH, type Turn } from "./call.ts";
import { around, captions, clock, heardAround, heardCaptions, hearWhole, copyPath, copyProgress, fetchCopy, frameAt, videoInfo, youtubeId } from "./video.ts";
import { CONFIG_PATH, diagramEndpoint, loadConfig, toPublic, updateConfig } from "./config.ts";
import { saveGoal } from "./goals.ts";
import { continueAfterAnswer, restartCard, explainRegion, explainRelation, explainSelection, handleChat, extendPiece, findFor, makeObject, mapCourses, pointAt, readSource, refillSections, shapeSections } from "./explain.ts";
import { looksLikeLink } from "./pages.ts";
import { addNote, editNote, noteHistory } from "./notes.ts";
import { arxivPdf, parseArxivId, searchArxiv } from "./arxiv.ts";
import { listModels, runSearch, testLlm, testSystemOne, testTts } from "./providers.ts";
import { addToLibrary, beginLink, finishLink, getLink, listLibrary, safeBack, unlink, zoteroAvailable } from "./zotero.ts";

const app = new Hono<{ Variables: { user: User } }>();

// ---- Accounts ----
// Off unless LIBRARIAN_AUTH=on: a local copy has one user, who can do everything.

const authHandler = auth;
if (authHandler) app.on(["GET", "POST"], "/api/auth/*", (c) => authHandler.handler(c.req.raw));

app.get("/api/me", async (c) => {
  const user = await currentUser(c.req.raw);
  const zotero = (await zoteroAvailable()) ? { linked: user ? ((await getLink(user.id))?.username ?? null) : null } : undefined;
  return c.json({ accounts: AUTH_ON, providers: PROVIDERS, user, speech: { tts: await canSpeak(), stt: Boolean(SPEECH.stt) }, zotero });
});

// ---- Moving to a new address ----
// Sessions belong to an address, so after a move people would arrive at the new one as strangers,
// cut off from their canvases (most people never sign in). The old address sends every visit here
// first: whoever it was there gets a one-time token, and claiming it at the new address (as whoever
// they are there) brings their canvases along. Then they land on the page they asked for.
const handoffs = new Map<string, { from: string; until: number }>();
const HOME = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
const localPath = (p: string | undefined) => (p && p.startsWith("/") && !p.startsWith("//") ? p : "/");

app.get("/api/handoff", async (c) => {
  const to = localPath(c.req.query("to"));
  const user = AUTH_ON ? await currentUser(c.req.raw) : null;
  if (!user) return c.redirect(`${HOME}${to}`, 302);
  const token = randomBytes(18).toString("base64url");
  handoffs.set(token, { from: user.id, until: Date.now() + 10 * 60_000 });
  return c.redirect(`${HOME}/handoff?t=${token}&to=${encodeURIComponent(to)}`, 302);
});

// Everything else under /api needs someone signed in, except images, which are named by their
// content hash and carry nothing private.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/me" || c.req.path.startsWith("/api/assets/") || c.req.path.startsWith("/api/videos/")) return next();
  const user = await currentUser(c.req.raw);
  if (!user) return c.json({ error: "sign in first" }, 401);
  c.set("user", user);
  return next();
});

// Models, keys and searchers are shared by everyone, so only admins (who gave the administrator
// password, admin.ts) see or change them.
const adminOnly = async (c: Context<{ Variables: { user: User } }>, next: Next) =>
  c.get("user").admin ? next() : c.json({ error: "only an admin can do that" }, 403);
app.use("/api/config", adminOnly);
app.use("/api/test/*", adminOnly);
app.use("/api/models/*", adminOnly);
app.use("/api/search", adminOnly);
app.use("/api/admin/password", adminOnly);

// Unlocking with the administrator password (see admin.ts) marks this browser as an admin's.
app.post("/api/admin/unlock", async (c) => {
  const { password } = (await c.req.json().catch(() => ({}))) as { password?: unknown };
  const cookie = typeof password === "string" ? await unlock(password) : null;
  if (!cookie) return c.json({ error: "that isn't the administrator password" }, 403);
  c.header("Set-Cookie", cookie);
  return c.json({ ok: true });
});
app.post("/api/admin/lock", (c) => {
  c.header("Set-Cookie", lockedCookie());
  return c.json({ ok: true });
});
app.get("/api/admin/password", (c) => c.json({ fromEnv: PASSWORD_FROM_ENV }));
app.put("/api/admin/password", async (c) => {
  const { password } = (await c.req.json().catch(() => ({}))) as { password?: unknown };
  try {
    c.header("Set-Cookie", changePassword(typeof password === "string" ? password : ""));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

/**
 * Who may open a canvas: its owner (for one from before accounts, an admin; everyone, with accounts
 * off), and whoever it's shared with.
 */
const canOpen = (info: CanvasInfo, user: User) => roleOf(info, user, AUTH_ON) !== null;

/** A canvas's details as someone with this role may see them: links only for its owner, nobody's read marks. */
function infoFor(info: CanvasInfo, role: Role) {
  const { links, seen, ...rest } = info;
  return { ...rest, role, ...(role === "owner" ? { links: links ?? [] } : {}) };
}

/** The name someone goes by on a canvas: what they gave when they joined, or their account's. */
const nameOn = (info: CanvasInfo, user: User) => info.members?.find((m) => m.id === user.id)?.name || user.name || "Someone";

// On a canvas: someone it's shared with to view can look but not change anything, and everything
// done for a request (and the work it starts) is recorded as done by whoever asked.
const onCanvas = async (c: Context<{ Variables: { user: User } }>, next: Next) => {
  const info = await getCanvasInfo(c.req.param("cid") ?? "");
  const user = c.get("user");
  const role = info ? roleOf(info, user, AUTH_ON) : null;
  if (!info || !role) return next();
  if (role === "viewer" && c.req.method !== "GET") return c.json({ error: "you can only view this canvas" }, 403);
  return actor.run({ id: user.id, name: nameOn(info, user) }, next);
};
app.use("/api/canvases/:cid", onCanvas);
app.use("/api/canvases/:cid/*", onCanvas);

/** Only the canvas's owner may do this (share it, trash or delete it). */
async function ownerOnly(c: Context<{ Variables: { user: User } }>) {
  const info = await getCanvasInfo(c.req.param("cid") ?? "");
  return info && roleOf(info, c.get("user"), AUTH_ON) === "owner" ? info : null;
}

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
app.post("/api/test/tts", async (c) => c.json(await testTts((await loadConfig()).tts)));
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
        ...infoFor(info, roleOf(info, user, AUTH_ON)!),
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
  if (typeof trashed === "boolean" && !(await ownerOnly(c))) return c.json({ error: "only its owner can do that" }, 403);
  const info = await updateCanvas(c.req.param("cid"), { name, trashed: typeof trashed === "boolean" ? trashed : undefined });
  return info ? c.json(info) : c.json({ error: "unknown canvas" }, 404);
});

// Deletes a canvas for good. The client asks first; this can't be undone.
app.delete("/api/canvases/:cid", async (c) => {
  if (!(await canvasFor(c))) return c.json({ error: "unknown canvas" }, 404);
  if (!(await ownerOnly(c))) return c.json({ error: "only its owner can do that" }, 403);
  return (await deleteCanvas(c.req.param("cid"))) ? c.json({ ok: true }) : c.json({ error: "unknown canvas" }, 404);
});

// Which examples are ready-made canvases; the rest start from their link or question.
app.get("/api/examples", async (c) => c.json({ prepared: Object.keys(await preparedExamples()) }));

// Opens an example: a copy of its canvas, the visitor's own to explore further.
app.post("/api/examples/:key", async (c) => {
  const id = (await preparedExamples())[c.req.param("key")];
  if (!id) return c.json({ error: "no such example" }, 404);
  const { name } = (await c.req.json().catch(() => ({}))) as { name?: string };
  const info = await duplicateCanvas(id, AUTH_ON ? c.get("user").id : undefined, typeof name === "string" && name.trim() ? name.trim() : undefined);
  return info ? c.json(info) : c.json({ error: "no such example" }, 404);
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
  return c.json({ ...infoFor(info!, roleOf(info!, c.get("user"), AUTH_ON)!), ...view });
});

// Claiming a handoff from the old address: what that visitor had is now yours. Each token works once.
app.post("/api/handoff/claim", async (c) => {
  const { t } = (await c.req.json().catch(() => ({}))) as { t?: string };
  const h = typeof t === "string" ? handoffs.get(t) : undefined;
  if (t) handoffs.delete(t);
  if (!h || h.until < Date.now()) return c.json({ error: "that hand-off has expired" }, 404);
  const me = c.get("user").id;
  if (h.from !== me) await transferCanvases(h.from, me);
  return c.json({ ok: true });
});

// ---- Sharing ----

// A link anyone can join with, as an editor or a viewer. Only the owner makes or removes them.
app.post("/api/canvases/:cid/links", async (c) => {
  const info = await ownerOnly(c);
  if (!info) return c.json({ error: "only its owner can share it" }, 403);
  const { role } = (await c.req.json().catch(() => ({}))) as { role?: string };
  if (role !== "editor" && role !== "viewer") return c.json({ error: "role is editor or viewer" }, 400);
  const user = c.get("user");
  return c.json(await addShareLink(info.id, role, { id: user.id, name: user.name || "The owner" }));
});

app.delete("/api/canvases/:cid/links/:token", async (c) => {
  const info = await ownerOnly(c);
  if (!info) return c.json({ error: "only its owner can do that" }, 403);
  return (await removeShareLink(info.id, c.req.param("token"))) ? c.json({ ok: true }) : c.json({ error: "no such link" }, 404);
});

app.delete("/api/canvases/:cid/members/:uid", async (c) => {
  const info = await ownerOnly(c);
  if (!info) return c.json({ error: "only its owner can do that" }, 403);
  return (await removeMember(info.id, c.req.param("uid"))) ? c.json({ ok: true }) : c.json({ error: "not a member" }, 404);
});

// What a link is to, before joining: the canvas's name, who shared it, and what it lets you do.
app.get("/api/join/:token", async (c) => {
  const token = c.req.param("token");
  const info = (await listCanvases()).find((x) => !x.trashedAt && x.links?.some((l) => l.token === token));
  if (!info) return c.json({ error: "that link doesn't work any more" }, 404);
  const role = info.links!.find((l) => l.token === token)!.role;
  return c.json({ name: info.name, ownerName: info.ownerName ?? "Someone", role, already: roleOf(info, c.get("user"), AUTH_ON) });
});

// Joining with a link: the canvas is then in your list. A visitor not signed in gives a name, so
// the owner can tell who changed what.
app.post("/api/join/:token", async (c) => {
  const user = c.get("user");
  const { name } = (await c.req.json().catch(() => ({}))) as { name?: string };
  const given = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  const info = await joinByLink(c.req.param("token"), { id: user.id, name: given || user.name || "Someone" });
  return info ? c.json({ id: info.id, name: info.name }) : c.json({ error: "that link doesn't work any more" }, 404);
});

// What other people did here since you last looked; the first time, nothing (you've seen it as it is).
app.get("/api/canvases/:cid/since", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const info = (await getCanvasInfo(store.id))!;
  const me = c.get("user").id;
  const state = await store.getState();
  const since = info.seen?.[me];
  if (since === undefined) {
    await markSeen(store.id, me, state.seq);
    return c.json({ since: state.seq, latest: state.seq, changes: [] });
  }
  return c.json({ since, latest: state.seq, changes: changesSince(await store.events(), since, me, state.items) });
});

app.post("/api/canvases/:cid/seen", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { seq } = (await c.req.json().catch(() => ({}))) as { seq?: number };
  const latest = (await store.getState()).seq;
  await markSeen(store.id, c.get("user").id, Math.min(typeof seq === "number" ? seq : latest, latest));
  return c.json({ ok: true });
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
  if (!(await canSpeak())) return c.json({ error: "speech isn't set up on this server" }, 404);
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
  const body = (await c.req.json()) as { text?: string; pointing?: Pointing; history?: Turn[]; context?: CallContext };
  const text = body.text?.trim().slice(0, 2000);
  if (!text) return c.json({ error: "text is required" }, 400);
  // A stray syllable or noise gets no answer at all (the call goes on listening).
  if (!substantive(text) && body.context?.picked === undefined) return c.json({ say: "" });
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
    note: (text, on) => addNote(store, { text, by: "librarian", via: "call", on, said: body.text }),
    relate: (a, b) => relate(store, a, b),
    open: async (input, near) => {
      // Beside what they're pointing at, else to the right of everything, level with the top.
      const { items } = await store.getState();
      const shown = items.filter((i) => !i.hidden && i.kind !== "region") as (CardItem | ImageItem | NoteItem)[];
      const cards = shown.filter((i): i is CardItem => i.kind === "card");
      const at = near
        ? besideOf(cards, near, (x) => x.h ?? (x.sem ? 900 : 300))
        : { x: shown.length ? Math.max(...shown.map((i) => i.x + i.w)) + 120 : 0, y: shown.length ? Math.min(...shown.map((i) => i.y)) : 0 };
      const r = await addSource(store, input, at);
      const id = r.card?.id ?? r.image?.id ?? "";
      const what = r.images ? `${r.total ?? r.images.length} pages of a PDF` : r.image?.video ? `the video "${r.image.video.title}"` : r.card?.origin?.kind === "page" ? `the page ${input}` : `a card on "${input.slice(0, 80)}"`;
      return { id, what };
    },
    descend: async (card, phrase) => {
      const cards = (await store.getState()).items.filter((i): i is CardItem => i.kind === "card" && !i.hidden);
      const at = besideOf(cards, card, (x) => x.h ?? (x.sem ? 900 : 300));
      const child: CardItem = { kind: "card", id: newId(), parentId: card.id, selection: phrase, ...at, w: CARD_WIDTH, stage: "reading", subject: phrase };
      await store.add(child);
      void explainSelection(store, child.id);
      return child;
    },
  }, body.context ?? {}).catch((err) => {
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

// Goals: the learner adds one of their own, or changes one (reword, finish, clear, reopen, move,
// or give it a card). Rewording keeps what it was; a whole goal sent back (undo) is put as it was.
app.post("/api/canvases/:cid/goals", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const body = (await c.req.json()) as { text?: string; parentId?: string };
  const text = String(body.text ?? "").trim().slice(0, 200);
  if (!text) return c.json({ error: "text is required" }, 400);
  const goals = (await store.getState()).goals ?? [];
  const parentId = goals.find((g) => g.id === body.parentId)?.id;
  const goal: Goal = { id: newId(), text, ...(parentId ? { parentId } : {}), kind: parentId ? "subgoal" : "goal", status: "open", cards: [], by: "you", at: new Date().toISOString() };
  await saveGoal(store, goal);
  return c.json({ goal });
});

app.patch("/api/canvases/:cid/goals/:gid", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const goals = (await store.getState()).goals ?? [];
  const goal = goals.find((g) => g.id === c.req.param("gid"));
  if (!goal) return c.json({ error: "unknown goal" }, 404);
  const body = (await c.req.json()) as Partial<Goal> & { restore?: Goal; addCard?: string; removeCard?: string };
  if (body.restore?.id === goal.id) {
    await saveGoal(store, body.restore);
    return c.json({ goal: body.restore });
  }
  const next: Goal = { ...goal };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 200) : "";
  if (text && text !== goal.text) {
    next.was = [...(goal.was ?? []), goal.text];
    next.text = text;
    next.by = "you";
  }
  if (body.status === "open" || body.status === "done" || body.status === "dropped") next.status = body.status;
  if (body.kind === "goal" || body.kind === "subgoal" || body.kind === "detour") next.kind = body.kind;
  if ("parentId" in body) {
    // Never under itself or one of its own.
    const below = (id: string | undefined): boolean => !!id && (id === goal.id || below(goals.find((g) => g.id === id)?.parentId));
    if (!body.parentId) delete next.parentId;
    else if (!below(body.parentId) && goals.some((g) => g.id === body.parentId)) next.parentId = body.parentId;
    if (!next.parentId) next.kind = "goal";
    else if (next.kind === "goal") next.kind = "subgoal";
  }
  if (body.addCard) {
    // A card works toward one goal: it moves here from wherever it was.
    for (const g of goals) if (g.id !== goal.id && g.cards.includes(body.addCard)) await saveGoal(store, { ...g, cards: g.cards.filter((x) => x !== body.addCard) });
    if (!next.cards.includes(body.addCard)) next.cards = [...next.cards, body.addCard];
  }
  if (body.removeCard) next.cards = next.cards.filter((x) => x !== body.removeCard);
  await saveGoal(store, next);
  return c.json({ goal: next });
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
  // The page retries a box on a slide by itself too (`auto`): that keeps the count of tries.
  const body = (await c.req.json().catch(() => ({}))) as { marked?: string; crop?: string; auto?: boolean };
  if (await restartCard(store, card.id, !body.auto)) return c.json({ ok: true });
  // A box on a slide: its crop comes from the page.
  if (!body.marked?.startsWith("data:image/") || !body.crop?.startsWith("data:image/")) {
    return c.json({ error: "marked and crop must be image data URLs" }, 400);
  }
  await store.update(card.id, { stage: "reading", error: "", retryAt: "", ...(body.auto ? {} : { retries: 0 }) });
  void explainRegion(store, card.id, { marked: body.marked, crop: body.crop });
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
  if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) return c.json({ error: "x and y are required" }, 400);
  const card = await relate(store, body.a, body.b, { x: body.x, y: body.y });
  return card ? c.json({ card }) : c.json({ error: "two different cards or images are required" }, 400);
});

/**
 * Asks how two things are related: a relation card hung from both (the Y connector), explained.
 * Either may be a card or a whole image. Without a place, it goes below the two, between them.
 */
async function relate(store: CanvasStore, aId: string, bId: string, at?: { x: number; y: number }): Promise<CardItem | null> {
  const [a, b] = await Promise.all([store.findItem(aId), store.findItem(bId)]);
  const relatable = (i: typeof a): i is CardItem | ImageItem => i?.kind === "card" || i?.kind === "image";
  if (!relatable(a) || !relatable(b) || a.id === b.id) return null;
  const label = (i: CardItem | ImageItem) => (i.kind === "card" ? (i.subject ?? "this") : (i.topic ?? i.name));
  const bottom = (i: CardItem | ImageItem) => i.y + (i.kind === "card" ? (i.h ?? (i.sem ? 900 : 300)) : i.h);
  const place = at ?? { x: Math.round((a.x + a.w / 2 + b.x + b.w / 2) / 2 - CARD_WIDTH / 2), y: Math.round(Math.max(bottom(a), bottom(b)) + 80) };
  const card: CardItem = {
    kind: "card",
    id: newId(),
    parentId: a.id,
    relates: [a.id, b.id],
    x: Math.round(place.x),
    y: Math.round(place.y),
    w: CARD_WIDTH,
    stage: "reading",
    subject: `${label(a)} ⟷ ${label(b)}`,
  };
  await store.add(card);
  void explainRelation(store, card.id);
  return card;
}

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
  try {
    return c.json(await addSource(store, input, { x: Math.round(body.x!), y: Math.round(body.y!) }));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

/**
 * Starts something new on the canvas from what was typed or pasted: a YouTube link (the video), a
 * PDF (its pages), any other link (the page, read), or a statement or question (explained).
 */
async function addSource(store: CanvasStore, input: string, at: { x: number; y: number }): Promise<{ card?: CardItem; answer?: CardItem; image?: ImageItem; images?: ImageItem[]; total?: number }> {
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
    // Someone put this video here, so they'll likely stop it and ask: have what was said ready.
    // YouTube's captions when it gives them; otherwise our own copy, heard once and kept.
    void captions(yt)
      .catch(() => [])
      .then((caps) => (caps.length || !SPEECH.stt ? undefined : fetchCopy(yt).then(() => hearWhole(yt, (wav) => listen(wav, info.title)))))
      .catch(() => {});
    return { image: video };
  }
  // A PDF (an arXiv paper, or any .pdf) becomes its pages, each a single-page PDF, ten to a row.
  const pdf = pdfLink(input) ?? (looksLikeLink(input) && (await servesPdf(input)) ? { url: input } : null);
  if (pdf) {
    {
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
      return { image: images[0], images, total: sliced.total };
    }
  }
  if (looksLikeLink(input)) {
    const card: CardItem = { kind: "card", id: newId(), parentId: "", origin: { kind: "page", url: input, title: input }, ...at, w: SOURCE_WIDTH, stage: "reading", subject: input };
    await store.add(card);
    void readSource(store, card.id);
    return { card };
  }
  // A statement is what you want to understand, so it is explained right away, beside it.
  const note: CardItem = { kind: "card", id: newId(), parentId: "", origin: { kind: "note", title: input }, ...at, w: CARD_WIDTH, stage: "done", subject: input, pageText: input };
  const answer: CardItem = { kind: "card", id: newId(), parentId: note.id, selection: input, x: at.x + CARD_WIDTH + 64, y: at.y, w: CARD_WIDTH, stage: "reading", subject: input };
  await store.add(note);
  await store.add(answer);
  void explainSelection(store, answer.id);
  return { card: note, answer };
}

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
  // YouTube's captions; or what our recogniser has already heard of our copy; or, for a stretch
  // it hasn't got to yet, heard now.
  let transcript = around(caps, t) || around(await heardCaptions(videoId), t);
  if (!transcript && SPEECH.stt) transcript = await heardAround(videoId, t, (wav) => listen(wav, title)).catch(() => "");
  // And the rest of it heard meanwhile (carrying on after a restart), so the next stop is instant.
  if (!caps.length && SPEECH.stt) void hearWhole(videoId, (wav) => listen(wav, title));
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
// Notes: words left on the canvas as they are, with who, when, about what and after what.
app.post("/api/canvases/:cid/notes", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const b = (await c.req.json()) as { text?: string; x?: number; y?: number; w?: number; on?: { id: string; key?: string; quote?: string } };
  const note = await addNote(store, { text: b.text ?? "", by: "you", via: "canvas", on: b.on?.id ? b.on : undefined, x: b.x, y: b.y, w: b.w });
  return note ? c.json({ note }) : c.json({ error: "text is required" }, 400);
});

app.patch("/api/canvases/:cid/notes/:id", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const { text } = (await c.req.json()) as { text?: string };
  if (!text?.trim()) return c.json({ error: "text is required" }, 400);
  const note = await editNote(store, c.req.param("id"), text, "you");
  return note ? c.json({ note }) : c.json({ error: "unknown note" }, 404);
});

app.get("/api/canvases/:cid/notes/:id/history", async (c) => {
  const store = await canvasFor(c);
  if (!store) return c.json({ error: "unknown canvas" }, 404);
  const h = await noteHistory(store, c.req.param("id"));
  return h ? c.json(h) : c.json({ error: "unknown note" }, 404);
});

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

// ---- Zotero ----
// A reader links their library with Zotero's own sign-in (zotero.ts); then they can see it here, start
// a canvas from anything in it, and add what the librarian finds.

/** Back from Zotero, or a failure there: to the page they came from, with a note for it to show. */
const zoteroBack = (back: string, error?: string) => `${back}${back.includes("?") ? "&" : "?"}zotero=${error ? encodeURIComponent(error) : "linked"}`;

app.get("/api/zotero/connect", async (c) => {
  const back = safeBack(c.req.query("back"));
  const site = HOME || new URL(c.req.url).origin;
  try {
    return c.redirect(await beginLink(c.get("user").id, `${site}/api/zotero/callback`, back), 302);
  } catch (err) {
    return c.redirect(zoteroBack(back, err instanceof Error ? err.message : String(err)), 302);
  }
});

app.get("/api/zotero/callback", async (c) => {
  const token = c.req.query("oauth_token") ?? "";
  const verifier = c.req.query("oauth_verifier");
  // Turned down on Zotero's page: no verifier comes back.
  if (!verifier) return c.redirect(zoteroBack("/zotero", "Zotero wasn't connected."), 302);
  try {
    return c.redirect(zoteroBack(await finishLink(c.get("user").id, token, verifier)), 302);
  } catch (err) {
    return c.redirect(zoteroBack("/zotero", err instanceof Error ? err.message : String(err)), 302);
  }
});

app.delete("/api/zotero", async (c) => {
  await unlink(c.get("user").id);
  return c.json({ ok: true });
});

app.get("/api/zotero/items", async (c) => {
  try {
    return c.json(await listLibrary(c.get("user").id, c.req.query("q") ?? "", Number(c.req.query("start")) || 0));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/zotero/items", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  try {
    const r = await addToLibrary(c.get("user").id, {
      url: str(body.url) ?? "",
      title: str(body.title) ?? "",
      authors: Array.isArray(body.authors) ? body.authors.filter((a): a is string => typeof a === "string").slice(0, 50) : undefined,
      date: str(body.date),
      abstract: str(body.abstract)?.slice(0, 5000),
      arxiv: str(body.arxiv),
    });
    return c.json(r);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
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
