// Canvases: each is an append-only log (data/canvases/<id>.jsonl) named in data/canvases/index.json.
// Image assets (data/assets/) are shared, stored by content hash.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Actor,
  type CanvasEvent,
  type Change,
  CARD_MAX_WIDTH,
  CARD_MIN_WIDTH,
  resizeBounds,
  type CanvasInfo,
  type CanvasState,
  type CardItem,
  type Item,
  type ItemPatch,
  type LoggedEvent,
  MIN_CHILD_GAP,
  type Move,
  type ReaderNote,
  RETRY_TRIES,
  type Role,
  type ShareLink,
} from "../shared/canvas.ts";

export const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");
const CANVAS_DIR = path.join(DATA_DIR, "canvases");
const INDEX_PATH = path.join(CANVAS_DIR, "index.json");
/** Where the single canvas lived before there were several. Copied once, then left as a backup. */
const LEGACY_LOG = path.join(DATA_DIR, "canvas.jsonl");
export const ASSET_DIR = path.join(DATA_DIR, "assets");

export const newId = () => randomUUID().slice(0, 8);

// ---- The index of canvases ----

let index: CanvasInfo[] | null = null;
let indexQueue: Promise<unknown> = Promise.resolve();

async function saveIndex(list: CanvasInfo[]) {
  await mkdir(CANVAS_DIR, { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(list, null, 2)}\n`);
  await rename(tmp, INDEX_PATH);
}

export async function listCanvases(): Promise<CanvasInfo[]> {
  if (index) return index;
  try {
    index = JSON.parse(await readFile(INDEX_PATH, "utf8")) as CanvasInfo[];
    return index;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // First run with several canvases: an older single canvas becomes the first one. Its log is
  // copied, not moved, so the original stays as a backup.
  const list: CanvasInfo[] = [];
  try {
    const id = newId();
    await mkdir(CANVAS_DIR, { recursive: true });
    await copyFile(LEGACY_LOG, path.join(CANVAS_DIR, `${id}.jsonl`));
    list.push({ id, name: "First canvas", createdAt: new Date().toISOString() });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await saveIndex(list);
  index = list;
  return list;
}

function changeIndex<T>(fn: (list: CanvasInfo[]) => T): Promise<T> {
  const run = indexQueue.then(async () => {
    const list = await listCanvases();
    const result = fn(list);
    await saveIndex(list);
    return result;
  });
  indexQueue = run.catch(() => {});
  return run;
}

const cleanName = (name: unknown) => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 120) : "");

/** What a canvas is called until it's named, by its owner or by what's on it. */
export const DEFAULT_NAME = "Untitled canvas";

/** A name for a canvas from what's on it: its first video, paper, page, slide or question. */
export function nameFromItems(items: Item[]): string {
  const shown = items.filter((i) => !i.hidden);
  const usable = (t: string | undefined) => {
    const s = (t ?? "").replace(/\s+/g, " ").trim();
    // Not a bare link (a page not read yet), a file name, or a placeholder.
    if (!s || /^https?:\/\//.test(s) || /\.(png|jpe?g|webp|gif|pdf)$/i.test(s) || s === "…" || s === "this") return "";
    if (s.length <= 80) return s;
    const cut = s.slice(0, 80);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`;
  };
  for (const i of shown) {
    let name = "";
    if (i.kind === "image") name = usable(i.video?.title) || usable(i.source?.title) || usable(i.moment?.title) || usable(i.topic);
    else if (i.kind === "card" && !i.parentId) name = usable(i.origin?.title) || usable(i.subject);
    else if (i.kind === "card") {
      // A box on a slide nobody has read whole yet: what the box was about.
      const parent = shown.find((p) => p.id === i.parentId);
      if (parent?.kind === "region") name = usable(i.topic) || usable(i.subject);
    }
    if (name) return name;
  }
  return "";
}

/** Names a canvas that still has the default name; a name someone chose is never replaced. */
export const autoName = (id: string, name: string) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    const clean = cleanName(name);
    if (info && clean && info.name === DEFAULT_NAME) info.name = clean;
    return info;
  });

export const createCanvas = (name: string, owner?: string) =>
  changeIndex((list) => {
    const info: CanvasInfo = {
      id: newId(),
      name: cleanName(name) || DEFAULT_NAME,
      createdAt: new Date().toISOString(),
      ...(owner ? { owner } : {}),
    };
    list.push(info);
    return info;
  });

/** Renames a canvas, or moves it into or out of the trash. */
export const updateCanvas = (id: string, change: { name?: string; trashed?: boolean }) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    if (!info) return null;
    const clean = cleanName(change.name);
    if (clean) info.name = clean;
    if (change.trashed === true && !info.trashedAt) info.trashedAt = new Date().toISOString();
    if (change.trashed === false) delete info.trashedAt;
    return info;
  });

/** Remembers something the reader said about their goal or background, for every later card. */
export const addReaderNote = (id: string, note: ReaderNote) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    if (info) info.reader = [...(info.reader ?? []), note].slice(-12);
  });

/** Gives everything one person has to another: an anonymous visitor's, when they sign in. */
export const transferCanvases = (from: string, to: string) =>
  changeIndex((list) => {
    for (const info of list) {
      if (info.owner === from) info.owner = to;
      for (const m of info.members ?? []) if (m.id === from) m.id = to;
      if (info.seen && from in info.seen) {
        info.seen[to] = Math.max(info.seen[to] ?? 0, info.seen[from]);
        delete info.seen[from];
      }
    }
  });

// ---- Sharing ----

/**
 * Who is acting, for the length of a request and all the work it starts (cards written, shapes
 * grown): every event recorded meanwhile says who it was by.
 */
export const actor = new AsyncLocalStorage<Actor>();

/** A new link that lets whoever has it join as an editor or a viewer. */
export const addShareLink = (id: string, role: ShareLink["role"], owner: Actor) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    if (!info) return null;
    const link: ShareLink = { token: randomBytes(12).toString("base64url"), role, createdAt: new Date().toISOString() };
    info.links = [...(info.links ?? []), link];
    info.ownerName = owner.name;
    return link;
  });

/** Stops a link working. Whoever already joined with it stays. */
export const removeShareLink = (id: string, token: string) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    const before = info?.links?.length ?? 0;
    if (info) info.links = (info.links ?? []).filter((l) => l.token !== token);
    return Boolean(info && (info.links?.length ?? 0) < before);
  });

/** Joins whoever has a link: as its role, or (already a member) at the better of the two. */
export const joinByLink = (token: string, who: Actor) =>
  changeIndex((list) => {
    const info = list.find((c) => !c.trashedAt && c.links?.some((l) => l.token === token));
    if (!info) return null;
    const role = info.links!.find((l) => l.token === token)!.role;
    if (info.owner === who.id) return info;
    const members = (info.members ??= []);
    const m = members.find((x) => x.id === who.id);
    if (m) {
      if (role === "editor") m.role = "editor";
      m.name = who.name || m.name;
    } else members.push({ id: who.id, name: who.name, role, joinedAt: new Date().toISOString() });
    return info;
  });

/** Takes someone off a canvas. */
export const removeMember = (id: string, memberId: string) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    const before = info?.members?.length ?? 0;
    if (info) info.members = (info.members ?? []).filter((m) => m.id !== memberId);
    return Boolean(info && (info.members?.length ?? 0) < before);
  });

/** What someone may do on a canvas, or null if they can't open it. */
export function roleOf(info: CanvasInfo, user: { id: string; admin: boolean }, accountsOn: boolean): Role | null {
  if (!accountsOn || info.owner === user.id || (!info.owner && user.admin)) return "owner";
  return info.members?.find((m) => m.id === user.id)?.role ?? null;
}

/** Remembers that someone has seen the canvas up to `seq`. */
export const markSeen = (id: string, userId: string, seq: number) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    if (!info) return;
    const seen = (info.seen ??= {});
    seen[userId] = Math.max(seen[userId] ?? 0, seq);
  });

/** What a thing on the canvas is called, for a list of changes. */
function labelOf(item: Item | undefined): string {
  if (!item) return "something";
  const cut = (t: string) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);
  if (item.kind === "card") return cut(item.subject ?? item.selection ?? item.origin?.title ?? "a card");
  if (item.kind === "note") return cut(`note: ${item.text}`);
  if (item.kind === "image") return cut(item.video?.title ?? item.source?.title ?? item.name ?? "an image");
  return "a box";
}

/**
 * What other people did after `since`, one entry per thing and kind of change (the newest time
 * and person). Work done for a change (a card being written after it was added) belongs to it.
 */
export function changesSince(events: LoggedEvent[], since: number, me: string, items: Item[]): Change[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const pos = new Map<string, { x: number; y: number }>();
  const out = new Map<string, Change>();
  const addedHere = new Set<string>();
  const put = (id: string, what: Change["what"], e: LoggedEvent, before?: { x: number; y: number }) => {
    const key = `${what}:${id}`;
    const had = out.get(key);
    // Removing something added meanwhile cancels both; putting back something removed meanwhile too.
    if (what === "removed" && out.has(`added:${id}`)) return void out.delete(`added:${id}`);
    if (what === "restored" && out.has(`removed:${id}`)) return void out.delete(`removed:${id}`);
    out.set(key, { id, what, by: e.by!, at: e.at, label: labelOf(byId.get(id)), ...(had?.before ?? before ? { before: had?.before ?? before } : {}) });
  };
  for (const e of events) {
    const ev = e.event;
    const theirs = e.seq > since && e.by && e.by.id !== me;
    if (ev.type === "add" && "x" in ev.item) pos.set(ev.item.id, { x: ev.item.x, y: ev.item.y });
    if (ev.type === "move") {
      for (const m of ev.moves) {
        if (theirs && !addedHere.has(m.id)) put(m.id, "moved", e, pos.get(m.id));
        pos.set(m.id, { x: m.x, y: m.y });
      }
      continue;
    }
    if (!theirs) continue;
    if (ev.type === "add") {
      addedHere.add(ev.item.id);
      put(ev.item.id, "added", e);
    } else if (ev.type === "hide" || ev.type === "show") {
      for (const id of ev.ids) put(id, ev.type === "hide" ? "removed" : "restored", e);
    } else if ((ev.type === "update" || ev.type === "chat") && !addedHere.has(ev.id)) {
      // The server's own bookkeeping on a card (stages, retries) isn't someone changing it.
      if (ev.type === "update" && !("ext" in ev.patch || "text" in ev.patch || "chat" in ev.patch || "sem" in ev.patch || "object" in ev.patch)) continue;
      put(ev.id, "changed", e);
    } else if (ev.type === "goal") put(ev.goal.id, "goal", { ...e }, undefined);
  }
  // Goals aren't items: they're named by their text.
  for (const c of out.values()) if (c.what === "goal") c.label = "a goal";
  return [...out.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** A new canvas holding a copy of everything on another, as of now. */
export async function duplicateCanvas(id: string, owner?: string, name?: string): Promise<CanvasInfo | null> {
  const from = await getCanvasInfo(id);
  if (!from) return null;
  const store = await canvasStore(id);
  await store?.settled();
  const info = await createCanvas((name ?? `Copy of ${from.name}`).slice(0, 120), owner);
  try {
    await copyFile(path.join(CANVAS_DIR, `${id}.jsonl`), path.join(CANVAS_DIR, `${info.id}.jsonl`));
  } catch (err) {
    // A canvas nothing was ever added to has no log yet; the copy is simply empty too.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return info;
}

// ---- Examples ----

// The home page's examples, each a canvas already explored a few levels deep. Opening one gives
// the visitor a copy of their own. data/examples.json maps an example's key to its canvas.
const EXAMPLES_FILE = () => path.join(DATA_DIR, "examples.json");

export async function preparedExamples(): Promise<Record<string, string>> {
  try {
    const map = JSON.parse(await readFile(EXAMPLES_FILE(), "utf8")) as Record<string, string>;
    const ids = new Set((await listCanvases()).map((c) => c.id));
    return Object.fromEntries(Object.entries(map).filter(([, id]) => typeof id === "string" && ids.has(id)));
  } catch {
    return {};
  }
}

export async function getCanvasInfo(id: string): Promise<CanvasInfo | undefined> {
  return (await listCanvases()).find((c) => c.id === id);
}

// ---- One canvas ----

function apply(s: CanvasState, logged: LoggedEvent): void {
  const e = logged.event;
  if (e.type === "add") s.items.push(e.item);
  else if (e.type === "update") {
    const item = s.items.find((i) => i.id === e.id);
    if (item?.kind === "card") Object.assign(item, e.patch);
    else if (item?.kind === "note") Object.assign(item, { text: e.patch.text ?? item.text, was: e.patch.was ?? item.was, edited: e.patch.edited ?? item.edited });
    else if (item?.kind === "image")
      Object.assign(item, { pageText: e.patch.pageText ?? item.pageText, topic: e.patch.topic ?? item.topic, video: e.patch.video ?? item.video });
  } else if (e.type === "goal") {
    const goals = (s.goals ??= []);
    const at = goals.findIndex((g) => g.id === e.goal.id);
    if (at >= 0) goals[at] = e.goal;
    else goals.push(e.goal);
  } else if (e.type === "z") {
    for (const o of e.order) {
      const item = s.items.find((i) => i.id === o.id);
      if (item && item.kind !== "region") item.z = o.z;
    }
  } else if (e.type === "chat") {
    const item = s.items.find((i) => i.id === e.id);
    if (item?.kind === "card") item.chat = [...(item.chat ?? []), e.message];
  } else if (e.type === "collapse") {
    const ids = new Set(e.ids);
    for (const item of s.items) if (ids.has(item.id)) item.collapsed = e.collapsed;
  } else if (e.type === "move") {
    for (const m of e.moves) {
      const item = s.items.find((i) => i.id === m.id);
      if (item && item.kind !== "region") Object.assign(item, { x: m.x, y: m.y }, (item.kind !== "image" || resizeBounds(item)) && m.h ? { h: m.h } : {}, (item.kind !== "image" || resizeBounds(item)) && m.w ? { w: m.w } : {});
    }
  } else {
    const ids = new Set(e.ids);
    for (const item of s.items) if (ids.has(item.id)) item.hidden = e.type === "hide";
  }
  s.seq = logged.seq;
  s.updatedAt = logged.at;
}

/** What disappears along with an item: an image takes its boxes, a box its cards, a card the cards below it. */
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Height assumed for a card that has never been measured (it has never been moved). */
const UNKNOWN_HEIGHT = 200;

/** An item's rectangle after `moves`, for checking that a card doesn't sit on its source. */
function bounds(items: Item[], id: string, moved: Map<string, Move>): Box | null {
  const item = items.find((i) => i.id === id);
  // A removed thing isn't drawn, so there's nothing there to sit on.
  if (!item || item.hidden) return null;
  if (item.kind === "card") {
    const m = moved.get(id);
    const x = m?.x ?? item.x;
    const y = m?.y ?? item.y;
    return { left: x, right: x + item.w, top: y, bottom: y + (m?.h ?? item.h ?? UNKNOWN_HEIGHT) };
  }
  if (item.kind === "region") {
    const img = items.find((i) => i.id === item.imageId);
    if (img?.kind !== "image" || img.hidden) return null;
    const k = img.w / img.naturalW;
    const m = moved.get(img.id);
    const x = (m?.x ?? img.x) + item.rect.x * k;
    const y = (m?.y ?? img.y) + item.rect.y * k;
    return { left: x, right: x + item.rect.w * k, top: y, bottom: y + item.rect.h * k };
  }
  return null;
}

/** Whether two boxes come closer than `gap` on every axis, i.e. one sits on the other. */
const overlaps = (a: Box, b: Box, gap: number) =>
  !(a.right + gap <= b.left + 0.5 || b.right + gap <= a.left + 0.5 || a.bottom + gap <= b.top + 0.5 || b.bottom + gap <= a.top + 0.5);

export class CanvasStore {
  private state: CanvasState | null = null;
  // Appends are serialized so seq numbers and file order always agree.
  private queue: Promise<unknown> = Promise.resolve();
  private readonly logPath: string;

  constructor(readonly id: string) {
    this.logPath = path.join(CANVAS_DIR, `${id}.jsonl`);
  }

  async getState(): Promise<CanvasState> {
    if (this.state) return this.state;
    const s: CanvasState = { seq: 0, items: [] };
    try {
      const text = await readFile(this.logPath, "utf8");
      for (const line of text.split("\n")) if (line.trim()) apply(s, JSON.parse(line));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // A card left mid-flight by a restart starts over by itself in a moment (one of its tries), rather
    // than spin forever. One waiting for the reader's answer to a question just goes on waiting.
    const stuck = s.items.filter((i): i is CardItem => i.kind === "card" && !i.hidden && i.stage !== "done" && i.stage !== "failed" && i.stage !== "asking");
    this.state = s;
    for (const card of stuck) {
      const tries = card.retries ?? 0;
      await this.update(card.id, {
        stage: "failed",
        error: "Interrupted by a server restart",
        ...(tries < RETRY_TRIES ? { retries: tries + 1, retryAt: new Date(Date.now() + 1000).toISOString() } : { retryAt: "" }),
      });
    }
    // Same for a copy of a video being fetched; it can be asked for again.
    for (const img of s.items) {
      if (img.kind === "image" && img.video?.hosted === "downloading") await this.update(img.id, { video: { ...img.video, hosted: "failed" } });
    }
    for (const card of s.items) {
      if (card.kind !== "card" || !card.chatPending) continue;
      await this.record({ type: "chat", id: card.id, message: { role: "assistant", text: "(Interrupted by a server restart; ask again.)", at: new Date().toISOString() } });
      await this.update(card.id, { chatPending: false });
    }
    // Background work a restart interrupted (shapes, sections, crops, growth, retries due) is picked
    // up again by whoever registered to resume it (explain.ts), now that the state is settled.
    if (resumeWork) {
      const resume = resumeWork;
      setTimeout(() => resume(this, s.items), 0);
    }
    return s;
  }

  record(event: CanvasEvent): Promise<LoggedEvent> {
    const by = actor.getStore();
    const run = this.queue.then(async () => {
      const s = await this.getState();
      const logged: LoggedEvent = { seq: s.seq + 1, at: new Date().toISOString(), event, ...(by ? { by } : {}) };
      await mkdir(CANVAS_DIR, { recursive: true });
      await appendFile(this.logPath, `${JSON.stringify(logged)}\n`);
      apply(s, logged);
      return logged;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Work in progress, such as a diagram being drawn as the model writes it. Held in memory and
   * shown to viewers, never written to the log: only the finished result is recorded.
   */
  private live = new Map<string, Partial<CardItem>>();

  /** When each card's job began, for the seconds its progress shows. */
  private began = new Map<string, number>();

  /** Merged into what's already held: a diagram drawn so far and the tokens so far sit side by side. */
  setLive(id: string, patch: Partial<CardItem>) {
    const next = { ...this.live.get(id), ...patch };
    for (const k of Object.keys(next) as (keyof CardItem)[]) if (next[k] === undefined) delete next[k];
    this.live.set(id, next);
  }

  clearLive(id: string) {
    this.live.delete(id);
  }

  /** A card's job begins: it shows 0 tokens and counts the seconds until endProgress. */
  startProgress(id: string) {
    this.began.set(id, Date.now());
    this.setLive(id, { progress: { tokens: 0, ms: 0 } });
  }

  endProgress(id: string) {
    this.began.delete(id);
    this.clearLive(id);
  }

  /** The canvas as viewers should see it: the log's state with any work in progress laid over. */
  async view(): Promise<CanvasState> {
    const s = await this.getState();
    if (!this.live.size) return s;
    const now = Date.now();
    const over = (id: string) => {
      const patch = this.live.get(id)!;
      const began = this.began.get(id);
      return patch.progress && began ? { ...patch, progress: { ...patch.progress, ms: now - began } } : patch;
    };
    return { ...s, items: s.items.map((i) => (i.kind === "card" && this.live.has(i.id) ? { ...i, ...over(i.id) } : i)) };
  }

  /** The whole log, oldest first: for looking back at what happened (a note's history). */
  async events(): Promise<LoggedEvent[]> {
    await this.settled();
    try {
      const text = await readFile(this.logPath, "utf8");
      return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LoggedEvent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return [];
    }
  }

  /** Resolves once every event already sent has been written. */
  settled(): Promise<void> {
    return this.queue.then(() => {});
  }

  add = (item: Item) => this.record({ type: "add", item });
  update = async (id: string, patch: ItemPatch) => {
    const logged = await this.record({ type: "update", id, patch });
    if ((patch.stage === "done" || patch.stage === "asking") && cardDone) cardDone(this, id);
    return logged;
  };

  private editing: Promise<unknown> = Promise.resolve();

  /**
   * Reads an item and writes a change made from it, with no other edit in between: for patches
   * built from the item's current value (appending to a list), which concurrent requests would
   * otherwise overwrite.
   */
  edit<T>(id: string, change: (item: Item | undefined) => ItemPatch | null): Promise<T | void> {
    const run = this.editing.then(async () => {
      const patch = change(await this.findItem(id));
      if (patch) await this.update(id, patch);
    });
    this.editing = run.catch(() => {});
    return run;
  }

  async findItem(id: string): Promise<Item | undefined> {
    return (await this.getState()).items.find((i) => i.id === id);
  }

  /**
   * What disappears along with `ids`: an image takes its boxes, a box its cards, a card the
   * cards below it, and a relation either of the things it relates. Removing the only card on a
   * box also removes the box, which would be meaningless on its own.
   */
  async withDependents(ids: string[]): Promise<string[]> {
    const { items } = await this.getState();
    const visible = items.filter((i) => !i.hidden);
    const out = new Set(ids);
    for (const id of ids) {
      const item = visible.find((i) => i.id === id);
      if (item?.kind === "card") {
        const parent = visible.find((i) => i.id === item.parentId);
        const siblings = visible.filter((i) => i.kind === "card" && i.parentId === item.parentId);
        if (parent?.kind === "region" && siblings.every((s) => out.has(s.id))) out.add(parent.id);
      }
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of visible) {
        if (out.has(i.id)) continue;
        // A note goes with what it's about.
        const parent = i.kind === "region" ? i.imageId : i.kind === "card" ? i.parentId : i.kind === "note" ? i.on?.id : undefined;
        const viaRelation = i.kind === "card" && i.relates?.some((r) => out.has(r));
        if ((parent && out.has(parent)) || viaRelation) {
          out.add(i.id);
          grew = true;
        }
      }
    }
    return visible.filter((i) => out.has(i.id)).map((i) => i.id);
  }

  /**
   * Applies a set of moves if no card sits on what it explains. Any side is fine (left, right,
   * above, below), and a branch grows whichever way its first card was put.
   */
  async moveItems(moves: Move[]): Promise<{ ok: true } | { ok: false; error: string }> {
    const { items } = await this.getState();
    const moved = new Map(moves.map((m) => [m.id, m]));
    for (const m of moves) {
      const item = items.find((i) => i.id === m.id);
      if (!item || item.kind === "region") return { ok: false, error: `can't move ${m.id}` };
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return { ok: false, error: "x and y must be numbers" };
      if (m.w !== undefined && ((item.kind === "image" && !resizeBounds(item)) || !Number.isFinite(m.w))) return { ok: false, error: "only a card's, a note's, a video's or a PDF's width can be set" };
    }
    // Check every visible card whose own position or whose parent's position changes.
    for (const card of items) {
      if (card.kind !== "card" || card.hidden || card.relates) continue;
      const parent = items.find((i) => i.id === card.parentId);
      const parentMoved = parent && (moved.has(parent.id) || (parent.kind === "region" && moved.has(parent.imageId)));
      if (!moved.has(card.id) && !parentMoved) continue;
      const source = bounds(items, card.parentId, moved);
      const self = bounds(items, card.id, moved);
      if (source && self && overlaps(self, source, MIN_CHILD_GAP)) {
        return { ok: false, error: "an explanation can sit on any side of what it explains, but not on it" };
      }
    }
    await this.record({
      type: "move",
      moves: moves.map((m) => {
        const item = items.find((i) => i.id === m.id);
        const at = { id: m.id, x: Math.round(m.x), y: Math.round(m.y) };
        // A video or a PDF keeps its shape: its height follows the width it's given.
        if (item?.kind === "image") {
          const b = resizeBounds(item);
          if (!m.w || !b) return at;
          const w = Math.round(Math.min(b.max, Math.max(b.min, m.w)));
          return { ...at, w, h: Math.round((w * item.h) / item.w) };
        }
        return { ...at, ...(m.h ? { h: Math.round(m.h) } : {}), ...(m.w ? { w: Math.round(Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, m.w))) } : {}) };
      }),
    });
    return { ok: true };
  }
}

const stores = new Map<string, CanvasStore>();

let resumeWork: ((store: CanvasStore, items: Item[]) => void) | null = null;
let cardDone: ((store: CanvasStore, id: string) => void) | null = null;
/** Called each time a card is ready to read, or stops to ask something first (goals.ts places it under a goal). */
export function onCardDone(fn: (store: CanvasStore, id: string) => void) {
  cardDone = fn;
}

/** Registers what to do with interrupted background work when a canvas is first loaded. */
export function onResume(fn: (store: CanvasStore, items: Item[]) => void) {
  resumeWork = fn;
}

/**
 * Deletes a canvas for good: out of the index, and its log erased. The one thing in Librarian
 * that can't be undone, so the client asks first. Images stay in data/assets/ (they're shared
 * by content hash and may be on other canvases).
 */
export async function deleteCanvas(id: string): Promise<boolean> {
  const gone = await changeIndex((list) => {
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  });
  if (!gone) return false;
  stores.delete(id);
  await rm(path.join(CANVAS_DIR, `${id}.jsonl`), { force: true });
  return true;
}

/** The store for a canvas that exists, or undefined. One store per canvas, shared by all requests. */
export async function canvasStore(id: string): Promise<CanvasStore | undefined> {
  if (!(await getCanvasInfo(id))) return undefined;
  let s = stores.get(id);
  if (!s) {
    s = new CanvasStore(id);
    stores.set(id, s);
  }
  return s;
}

// ---- Assets, shared by every canvas ----

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" };

/** Saves an uploaded image under its content hash; the same image twice is stored once. */
export async function saveAsset(bytes: Buffer, mime: string): Promise<string> {
  const ext = Object.entries(MIME).find(([, m]) => m === mime)?.[0];
  if (!ext) throw new Error(`Unsupported image type ${mime}`);
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
  await mkdir(ASSET_DIR, { recursive: true });
  await writeFile(path.join(ASSET_DIR, name), bytes);
  return name;
}

export function assetPath(name: string): { file: string; mime: string } | null {
  if (!/^[0-9a-f]{16}\.(png|jpe?g|webp|gif|pdf)$/.test(name)) return null;
  return { file: path.join(ASSET_DIR, name), mime: MIME[name.split(".")[1]] };
}
