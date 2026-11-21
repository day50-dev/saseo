// Canvases: each is an append-only log (data/canvases/<id>.jsonl) named in data/canvases/index.json.
// Image assets (data/assets/) are shared, stored by content hash.
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CanvasEvent,
  type CanvasInfo,
  type CanvasState,
  type CardItem,
  type Item,
  type ItemPatch,
  type LoggedEvent,
  MIN_CHILD_GAP,
  type Move,
} from "../shared/canvas.ts";

const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");
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

export const createCanvas = (name: string) =>
  changeIndex((list) => {
    const info: CanvasInfo = { id: newId(), name: cleanName(name) || "Untitled canvas", createdAt: new Date().toISOString() };
    list.push(info);
    return info;
  });

export const renameCanvas = (id: string, name: string) =>
  changeIndex((list) => {
    const info = list.find((c) => c.id === id);
    const clean = cleanName(name);
    if (info && clean) info.name = clean;
    return info ?? null;
  });

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
    else if (item?.kind === "image") Object.assign(item, { pageText: e.patch.pageText ?? item.pageText, topic: e.patch.topic ?? item.topic });
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
      if (item && item.kind !== "region") Object.assign(item, { x: m.x, y: m.y }, item.kind === "card" && m.h ? { h: m.h } : {});
    }
  } else {
    const ids = new Set(e.ids);
    for (const item of s.items) if (ids.has(item.id)) item.hidden = e.type === "hide";
  }
  s.seq = logged.seq;
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
    // A card left mid-flight by a restart can't finish; record that rather than spin forever.
    const stuck = s.items.filter((i): i is CardItem => i.kind === "card" && i.stage !== "done" && i.stage !== "failed");
    this.state = s;
    for (const card of stuck) await this.update(card.id, { stage: "failed", error: "Interrupted by a server restart" });
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

  add = (item: Item) => this.record({ type: "add", item });
  update = (id: string, patch: ItemPatch) => this.record({ type: "update", id, patch });

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
      moves: moves.map((m) => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y), ...(m.h ? { h: Math.round(m.h) } : {}) })),
    });
    return { ok: true };
  }
}

const stores = new Map<string, CanvasStore>();

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

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

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
  if (!/^[0-9a-f]{16}\.(png|jpe?g|webp|gif)$/.test(name)) return null;
  return { file: path.join(ASSET_DIR, name), mime: MIME[name.split(".")[1]] };
}
