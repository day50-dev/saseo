// Canvases written straight into a test's data folder before the server starts: the same files the
// server keeps (an index and one append-only log per canvas), so tests can start from any state.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CardItem, Item } from "../../shared/canvas.ts";

export function seed(dataDir: string, canvases: { id: string; name: string; owner?: string; items: Item[] }[]) {
  const dir = path.join(dataDir, "canvases");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "index.json"),
    JSON.stringify(canvases.map(({ id, name, owner }) => ({ id, name, createdAt: "2026-11-01T00:00:00.000Z", ...(owner ? { owner } : {}) }))),
  );
  for (const c of canvases) {
    const lines = c.items.map((item, i) => JSON.stringify({ seq: i + 1, at: `2026-11-01T00:00:${String(i).padStart(2, "0")}.000Z`, event: { type: "add", item } }));
    writeFileSync(path.join(dir, `${c.id}.jsonl`), lines.length ? `${lines.join("\n")}\n` : "");
  }
}

/** A finished explanation card with a small diagram. */
export const explained = (id: string, subject: string, x = 0, y = 0, extra: Partial<CardItem> = {}): CardItem => ({
  kind: "card",
  id,
  parentId: "",
  x,
  y,
  w: 720,
  stage: "done",
  subject,
  sem: {
    why: [`People needed ${subject}`],
    what: { gist: `${subject} in one line`, details: [`A detail about ${subject}`] },
    parts: [],
    together: "",
    here: [`Where ${subject} is used`],
    name: "",
  },
  ...extra,
});

export const objectCard = (id: string, object: NonNullable<CardItem["object"]>, x = 0, y = 0, extra: Partial<CardItem> = {}): CardItem => ({
  kind: "card",
  id,
  parentId: "",
  x,
  y,
  w: 720,
  stage: "done",
  objectKind: object.type,
  object,
  request: "made in a test",
  subject: "title" in object ? String(object.title) : object.type,
  ...extra,
});
