// What reading a linked page produces, kept per URL, so the same page on any canvas is ready at
// once instead of being fetched, shaped and restructured section by section all over again.
// One JSON document per page in data/pages/. A page's text can differ a little from one fetch to
// the next, and shapes belong to the text they were drawn from, so each distinct text is kept as
// its own version; a new card takes the version with the most already done.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CardItem, PageSection, Sem } from "../shared/canvas.ts";
import { DATA_DIR } from "./canvas.ts";

const DIR = path.join(DATA_DIR, "pages");

export interface PageRead {
  at: string;
  title: string;
  site?: string;
  finalUrl: string;
  text: string;
}

/** One reading of a page and what's been drawn from it. */
export interface PageVersion {
  read: PageRead;
  shape?: { sem: Sem; anchors?: Record<string, number[]> };
  /** Finished sections, by index, with where they sit (so a changed split doesn't reuse them). */
  sections?: Record<string, PageSection>;
}

interface PageDoc {
  url: string;
  /** By sha1 of the text. */
  versions: Record<string, PageVersion>;
}

export const hashText = (text: string) => createHash("sha1").update(text).digest("hex");
const fileOf = (url: string) => path.join(DIR, `${createHash("sha1").update(url).digest("hex")}.json`);

async function load(url: string): Promise<PageDoc> {
  try {
    const raw = JSON.parse(await readFile(fileOf(url), "utf8")) as PageDoc & { read?: PageRead; textHash?: string } & Omit<PageVersion, "read">;
    if (raw.versions) return raw;
    // The first format kept one version only.
    return { url, versions: raw.read && raw.textHash ? { [raw.textHash]: { read: raw.read, shape: raw.shape, sections: raw.sections } } : {} };
  } catch {
    return { url, versions: {} };
  }
}

const work = (v: PageVersion) => (v.shape ? 1 : 0) + Object.keys(v.sections ?? {}).length;

/** The reading of a page with the most already drawn from it. */
export async function bestRead(url: string): Promise<PageRead | undefined> {
  const versions = Object.values((await load(url)).versions);
  versions.sort((a, b) => work(b) - work(a) || b.read.at.localeCompare(a.read.at));
  return versions[0]?.read;
}

/** What's been drawn from this exact text of a page. */
export async function pageVersion(url: string, text: string): Promise<PageVersion | undefined> {
  return (await load(url)).versions[hashText(text)];
}

// Writes for one page go one after another, each reading the last one's result.
const queues = new Map<string, Promise<unknown>>();

/** Changes one version of a page (read, change, write atomically); `null` leaves it as it is. */
export function editVersion(url: string, read: PageRead, change: (v: PageVersion) => PageVersion | null = (v) => v): Promise<void> {
  const prev = queues.get(url) ?? Promise.resolve();
  const next = prev.then(async () => {
    const doc = await load(url);
    const key = hashText(read.text);
    const before = doc.versions[key];
    const v = change(before ?? { read });
    if (!v || (before && JSON.stringify(v) === JSON.stringify(before))) return;
    doc.versions[key] = v;
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

/** The reading a card holds, as stored. */
export function readOf(card: CardItem): PageRead | undefined {
  const o = card.origin;
  if (o?.kind !== "page" || !card.pageText) return undefined;
  return { at: new Date().toISOString(), title: o.title, site: o.site, finalUrl: o.url, text: card.pageText };
}

/** Keeps whatever a finished page card already has (cards made before this store existed). */
export async function remember(card: CardItem) {
  const read = readOf(card);
  if (!read || card.origin?.kind !== "page" || card.stage !== "done") return;
  const done = Object.fromEntries((card.sections ?? []).flatMap((s, i) => (s.status === "done" ? [[String(i), s] as const] : [])));
  await editVersion(card.origin.url, read, (v) => ({
    read: v.read,
    shape: v.shape ?? (card.shaping === "done" && card.sem ? { sem: card.sem, anchors: card.anchors } : undefined),
    sections: { ...done, ...v.sections },
  }));
}
