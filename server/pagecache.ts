// What reading a linked page produces, kept per URL, so the same page on any canvas is ready at
// once instead of being fetched, shaped and restructured section by section all over again.
// One JSON document per page in data/pages/. Shapes are tied to the text they were drawn from:
// if a re-read finds the page changed, they're drawn again.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CardItem, PageSection, Sem } from "../shared/canvas.ts";
import { DATA_DIR } from "./canvas.ts";

const DIR = path.join(DATA_DIR, "pages");

export interface PageDoc {
  url: string;
  read?: { at: string; title: string; site?: string; finalUrl: string; text: string };
  /** sha1 of the text the shapes below were drawn from. */
  textHash?: string;
  shape?: { sem: Sem; anchors?: Record<string, number[]> };
  /** Finished sections, by index, with where they sit (so a changed split doesn't reuse them). */
  sections?: Record<string, PageSection>;
}

export const hashText = (text: string) => createHash("sha1").update(text).digest("hex");
const fileOf = (url: string) => path.join(DIR, `${createHash("sha1").update(url).digest("hex")}.json`);

export async function pageDoc(url: string): Promise<PageDoc | undefined> {
  try {
    return JSON.parse(await readFile(fileOf(url), "utf8")) as PageDoc;
  } catch {
    return undefined;
  }
}

// Writes for one page go one after another, each reading the last one's result.
const queues = new Map<string, Promise<unknown>>();

/** Changes a page's document: read, change, write (atomically). */
export function editPage(url: string, change: (doc: PageDoc) => PageDoc | null): Promise<void> {
  const prev = queues.get(url) ?? Promise.resolve();
  const next = prev.then(async () => {
    const doc = change((await pageDoc(url)) ?? { url });
    if (!doc) return;
    await mkdir(DIR, { recursive: true });
    const file = fileOf(url);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, file);
  });
  const settled = next.catch(() => {});
  queues.set(url, settled);
  void settled.then(() => queues.get(url) === settled && queues.delete(url));
  return next;
}

/** Keeps whatever a finished page card already has (cards made before this store existed). */
export async function remember(card: CardItem) {
  const origin = card.origin;
  if (origin?.kind !== "page" || card.stage !== "done" || !card.pageText) return;
  const text = card.pageText;
  const textHash = hashText(text);
  const done = Object.fromEntries((card.sections ?? []).flatMap((s, i) => (s.status === "done" ? [[String(i), s] as const] : [])));
  await editPage(origin.url, (doc) => {
    const same = doc.textHash === textHash;
    // The store has a different (later or earlier) reading of the page: leave it be.
    if (doc.textHash && !same) return null;
    const next: PageDoc = {
      url: origin.url,
      read: same && doc.read ? doc.read : { at: new Date().toISOString(), title: origin.title, site: origin.site, finalUrl: origin.url, text },
      textHash,
      shape: same && doc.shape ? doc.shape : card.shaping === "done" && card.sem ? { sem: card.sem, anchors: card.anchors } : undefined,
      sections: { ...done, ...(same ? doc.sections : {}) },
    };
    return JSON.stringify(next) === JSON.stringify(doc) ? null : next;
  });
}
