// Append-only canvas log (data/canvas.jsonl) and image assets (data/assets/).
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CanvasEvent,
  type CanvasState,
  type CardItem,
  type Item,
  type LoggedEvent,
  MIN_CHILD_GAP,
  type Move,
} from "../shared/canvas.ts";

const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");
const LOG_PATH = path.join(DATA_DIR, "canvas.jsonl");
export const ASSET_DIR = path.join(DATA_DIR, "assets");

let state: CanvasState | null = null;
// Appends are serialized so seq numbers and file order always agree.
let queue: Promise<unknown> = Promise.resolve();

function apply(s: CanvasState, logged: LoggedEvent): void {
  const e = logged.event;
  if (e.type === "add") s.items.push(e.item);
  else if (e.type === "update") {
    const item = s.items.find((i) => i.id === e.id);
    if (item?.kind === "card") Object.assign(item, e.patch);
  } else if (e.type === "collapse") {
    const ids = new Set(e.ids);
    for (const item of s.items) if (ids.has(item.id)) item.collapsed = e.collapsed;
  } else if (e.type === "move") {
    for (const m of e.moves) {
      const item = s.items.find((i) => i.id === m.id);
      if (item && item.kind !== "region") Object.assign(item, { x: m.x, y: m.y });
    }
  } else {
    const ids = new Set(e.ids);
    for (const item of s.items) if (ids.has(item.id)) item.hidden = e.type === "hide";
  }
  s.seq = logged.seq;
}

export async function getState(): Promise<CanvasState> {
  if (state) return state;
  const s: CanvasState = { seq: 0, items: [] };
  try {
    const text = await readFile(LOG_PATH, "utf8");
    for (const line of text.split("\n")) if (line.trim()) apply(s, JSON.parse(line));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // A card left mid-flight by a restart can't finish; record that rather than spin forever.
  const stuck = s.items.filter(
    (i): i is CardItem => i.kind === "card" && i.stage !== "done" && i.stage !== "failed",
  );
  state = s;
  for (const card of stuck) await record({ type: "update", id: card.id, patch: { stage: "failed", error: "Interrupted by a server restart" } });
  return s;
}

export function record(event: CanvasEvent): Promise<LoggedEvent> {
  const run = queue.then(async () => {
    const s = await getState();
    const logged: LoggedEvent = { seq: s.seq + 1, at: new Date().toISOString(), event };
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(LOG_PATH, `${JSON.stringify(logged)}\n`);
    apply(s, logged);
    return logged;
  });
  queue = run.catch(() => {});
  return run;
}

export const add = (item: Item) => record({ type: "add", item });
export const update = (id: string, patch: Partial<CardItem>) => record({ type: "update", id, patch });

/**
 * What disappears along with `ids`: an image takes its boxes, a box its cards, a card the
 * cards below it. Removing the only card on a box also removes the box, which would be
 * meaningless on its own.
 */
export async function withDependents(ids: string[]): Promise<string[]> {
  const { items } = await getState();
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
      if (parent && out.has(parent)) {
        out.add(i.id);
        grew = true;
      }
    }
  }
  return visible.filter((i) => out.has(i.id)).map((i) => i.id);
}

/** An item's left and right edges after `moves`, for checking that cards sit beside their source. */
function edges(items: Item[], id: string, moved: Map<string, Move>): { left: number; right: number } | null {
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  if (item.kind === "card") {
    const x = moved.get(id)?.x ?? item.x;
    return { left: x, right: x + item.w };
  }
  if (item.kind === "region") {
    const img = items.find((i) => i.id === item.imageId);
    if (img?.kind !== "image") return null;
    const k = img.w / img.naturalW;
    const x = (moved.get(img.id)?.x ?? img.x) + item.rect.x * k;
    return { left: x, right: x + item.rect.w * k };
  }
  return null;
}

/**
 * Applies a set of moves if every card still sits beside what it explains: wholly to its right or
 * wholly to its left (a branch can grow either way), never on top of it.
 */
export async function moveItems(moves: Move[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const { items } = await getState();
  const moved = new Map(moves.map((m) => [m.id, m]));
  for (const m of moves) {
    const item = items.find((i) => i.id === m.id);
    if (!item || item.kind === "region") return { ok: false, error: `can't move ${m.id}` };
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return { ok: false, error: "x and y must be numbers" };
  }
  // Check every visible card whose own position or whose parent's position changes.
  for (const card of items) {
    if (card.kind !== "card" || card.hidden) continue;
    const parent = items.find((i) => i.id === card.parentId);
    const parentMoved = parent && (moved.has(parent.id) || (parent.kind === "region" && moved.has(parent.imageId)));
    if (!moved.has(card.id) && !parentMoved) continue;
    const e = edges(items, card.parentId, moved);
    const x = moved.get(card.id)?.x ?? card.x;
    const rightOf = e !== null && x >= e.right + MIN_CHILD_GAP - 0.5;
    const leftOf = e !== null && x + card.w <= e.left - MIN_CHILD_GAP + 0.5;
    if (e !== null && !rightOf && !leftOf) {
      return { ok: false, error: "an explanation must sit beside what it explains, to its left or right" };
    }
  }
  await record({ type: "move", moves: moves.map((m) => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y) })) });
  return { ok: true };
}

export async function findItem(id: string): Promise<Item | undefined> {
  return (await getState()).items.find((i) => i.id === id);
}

export const newId = () => randomUUID().slice(0, 8);

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
