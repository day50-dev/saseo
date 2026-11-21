// Append-only canvas log (data/canvas.jsonl) and image assets (data/assets/).
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanvasEvent, CanvasState, CardItem, Item, LoggedEvent } from "../shared/canvas.ts";

const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");
const LOG_PATH = path.join(DATA_DIR, "canvas.jsonl");
export const ASSET_DIR = path.join(DATA_DIR, "assets");

let state: CanvasState | null = null;
// Appends are serialized so seq numbers and file order always agree.
let queue: Promise<unknown> = Promise.resolve();

function apply(s: CanvasState, logged: LoggedEvent): void {
  const e = logged.event;
  if (e.type === "add") s.items.push(e.item);
  else {
    const item = s.items.find((i) => i.id === e.id);
    if (item?.kind === "card") Object.assign(item, e.patch);
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
