// Canvases: each is an append-only log (data/canvases/<id>.jsonl) named in data/canvases/index.json.
// Image assets (data/assets/) are shared, stored by content hash.
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CanvasEvent,
  CARD_MAX_WIDTH,
  CARD_MIN_WIDTH,
  type CanvasInfo,
  type CanvasState,
  type CardItem,
  type Item,
  type ItemPatch,
  type LoggedEvent,
  MIN_CHILD_GAP,
  type Move,
  type ReaderNote,
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

/** Gives every canvas one person owns to another: an anonymous visitor's, when they sign in. */
export const transferCanvases = (from: string, to: string) =>
  changeIndex((list) => {
    for (const info of list) if (info.owner === from) info.owner = to;
  });

/** A new canvas holding a copy of everything on another, as of now. */
export async function duplicateCanvas(id: string, owner?: string): Promise<CanvasInfo | null> {
  const from = await getCanvasInfo(id);
  if (!from) return null;
  const store = await canvasStore(id);
  await store?.settled();
  const info = await createCanvas(`Copy of ${from.name}`.slice(0, 120), owner);
  try {
    await copyFile(path.join(CANVAS_DIR, `${id}.jsonl`), path.join(CANVAS_DIR, `${info.id}.jsonl`));
  } catch (err) {
    // A canvas nothing was ever added to has no log yet; the copy is simply empty too.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return info;
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
      if (item && item.kind !== "region") Object.assign(item, { x: m.x, y: m.y }, item.kind === "card" && m.h ? { h: m.h } : {}, item.kind === "card" && m.w ? { w: m.w } : {});
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
  if (!item) return null;
  if (item.kind === "card") {
    const m = moved.get(id);
    const x = m?.x ?? item.x;
    const y = m?.y ?? item.y;
    return { left: x, right: x + item.w, top: y, bottom: y + (m?.h ?? item.h ?? UNKNOWN_HEIGHT) };
  }
  if (item.kind === "region") {
    const img = items.find((i) => i.id === item.imageId);
    if (img?.kind !== "image") return null;
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
    // Background work on cards that a restart interrupted (shapes, sections, crops, growth) is
    // picked up again by whoever registered to resume it (explain.ts), once this state is set.
    if (resumeWork) {
      const resume = resumeWork;
      setTimeout(() => resume(this, s.items), 0);
    }
    // A card left mid-flight by a restart can't finish; record that rather than spin forever.
    const stuck = s.items.filter((i): i is CardItem => i.kind === "card" && i.stage !== "done" && i.stage !== "failed");
    this.state = s;
    for (const card of stuck) await this.update(card.id, { stage: "failed", error: "Interrupted by a server restart" });
    // Same for a copy of a video being fetched; it can be asked for again.
    for (const img of s.items) {
      if (img.kind === "image" && img.video?.hosted === "downloading") await this.update(img.id, { video: { ...img.video, hosted: "failed" } });
    }
    for (const card of s.items) {
      if (card.kind !== "card" || !card.chatPending) continue;
      await this.record({ type: "chat", id: card.id, message: { role: "assistant", text: "(Interrupted by a server restart; ask again.)", at: new Date().toISOString() } });
      await this.update(card.id, { chatPending: false });
    }
    return s;
  }

  record(event: CanvasEvent): Promise<LoggedEvent> {
    const run = this.queue.then(async () => {
      const s = await this.getState();
      const logged: LoggedEvent = { seq: s.seq + 1, at: new Date().toISOString(), event };
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

  setLive(id: string, patch: Partial<CardItem>) {
    this.live.set(id, patch);
  }

  clearLive(id: string) {
    this.live.delete(id);
  }

  /** The canvas as viewers should see it: the log's state with any work in progress laid over. */
  async view(): Promise<CanvasState> {
    const s = await this.getState();
    if (!this.live.size) return s;
    return { ...s, items: s.items.map((i) => (i.kind === "card" && this.live.has(i.id) ? { ...i, ...this.live.get(i.id) } : i)) };
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
        const parent = i.kind === "region" ? i.imageId : i.kind === "card" ? i.parentId : undefined;
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
      if (m.w !== undefined && (item.kind !== "card" || !Number.isFinite(m.w))) return { ok: false, error: "only a card's width can be set" };
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
      moves: moves.map((m) => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y), ...(m.h ? { h: Math.round(m.h) } : {}), ...(m.w ? { w: Math.round(Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, m.w))) } : {}) })),
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
