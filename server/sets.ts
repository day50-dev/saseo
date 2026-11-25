// Card sets: a collection shown as a grid of tiles (2×3 or 3×3), like a set of videos. For a
// "who were the top…", "a list of…", "the key works of…": the model names the entries and says why
// each belongs; Wikipedia vouches for each one (its picture, its description, its link). An entry
// no article can be found for stays, flagged as the model's say-so.
import type { SetEntry } from "../shared/canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";

const WIKI = process.env.LIBRARIAN_WIKIPEDIA ?? "https://en.wikipedia.org";
const UA = "Librarian/1.0 (study canvas)";
export const SET_MAX = 9;

const SET = `A reader on a study canvas asked for a collection: the notable people, groups, works, places or things of a subject,
to look through as a set of cards. Choose up to 9 entries that best answer what they asked (the 6 to 9 most important, in a
sensible order: by importance, or by time when that's clearer). Only real, well-known entries you are sure of.
For each: its name, the title of its English Wikipedia article, a few words saying who or what it is (with years when they
help), and one sentence on why it belongs in this set. Also a short title for the set, and a one-sentence caption.
Return JSON only: {"title": "...", "caption": "...", "entries": [{"name": "...", "wikipedia": "...", "subtitle": "...", "note": "..."}]}`;

interface Summary {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  thumbnail?: { source?: string };
  content_urls?: { desktop?: { page?: string } };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const summary = (title: string) => getJson<Summary>(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`);

const STOP = new Set(["a", "an", "the", "of", "in", "on", "and", "for", "to", "with", "band", "film", "album", "song", "problem", "system", "systems"]);
const words = (t: string) => t.toLowerCase().replace(/\([^)]*\)/g, " ").match(/[\p{L}\p{N}]+/gu)?.filter((w) => !STOP.has(w)) ?? [];

/**
 * Whether an article's title is about the named thing, not just near it: every word of the
 * shorter of the two is in the longer ("Charged particle in a magnetic field" is not "Quantum
 * field theory"; "Wire" is "Wire (band)").
 */
export function sameThing(name: string, title: string): boolean {
  const a = words(name);
  const b = words(title);
  if (!a.length || !b.length) return name.trim().toLowerCase() === title.replace(/\s*\([^)]*\)$/, "").trim().toLowerCase();
  const [short, long] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  // Plurals and the like: "oscillators" is "oscillator".
  const has = (w: string) => long.has(w) || long.has(w.replace(/s$/, "")) || [...long].some((l) => l.replace(/s$/, "") === w);
  return short.every(has);
}

/**
 * The Wikipedia article for an entry: by the title the model gave, else a search for its name.
 * Either way the article must be about that thing; a near miss is no article at all (the entry is
 * then shown as not checked, rather than vouched for by something else).
 */
export async function wikiFor(name: string, title?: string): Promise<Summary | null> {
  const usable = (s: Summary | null) => (s && s.type !== "disambiguation" && s.title && (sameThing(name, s.title) || (title !== undefined && sameThing(title, s.title) && sameThing(name, title))) ? s : null);
  const direct = title ? usable(await summary(title)) : null;
  if (direct) return direct;
  const q = new URLSearchParams({ action: "query", list: "search", srsearch: name, srlimit: "5", format: "json" });
  const hits = (await getJson<{ query?: { search?: { title: string }[] } }>(`${WIKI}/w/api.php?${q}`))?.query?.search ?? [];
  for (const h of hits) {
    if (!sameThing(name, h.title)) continue;
    const s = usable(await summary(h.title));
    if (s) return s;
  }
  return null;
}

/**
 * A picture for an article with no lead image: its first real figure, in page order (not an icon,
 * a logo or a tiny inline image). Undefined when it has none.
 */
export async function firstFigure(title: string): Promise<string | undefined> {
  const list = await getJson<{ items?: { type?: string; title?: string; showInGallery?: boolean; srcset?: { src: string; scale?: string }[] }[] }>(
    `${WIKI}/api/rest_v1/page/media-list/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  );
  for (const m of list?.items ?? []) {
    if (m.type !== "image" || m.showInGallery === false || !m.srcset?.length) continue;
    if (/icon|logo|symbol|commons|wiki|question|disambig|edit|portal|stub/i.test(m.title ?? "")) continue;
    const src = m.srcset[0].src;
    // Thumbnails say their width ("/60px-…"); a small one is an inline icon.
    const px = Number(src.match(/\/(\d+)px-/)?.[1] ?? 999);
    if (px < 150) continue;
    return src.startsWith("//") ? `https:${src}` : src;
  }
  return undefined;
}

/** Makes a set for `request` about `about`: named by the model, checked against Wikipedia. */
export async function makeSet(request: string, about: string): Promise<{ title: string; caption?: string; entries: SetEntry[] }> {
  const r = await chatJson<{ title?: string; caption?: string; entries?: { name?: string; wikipedia?: string; subtitle?: string; note?: string }[] }>((await loadConfig()).llm, [
    { role: "system", content: SET },
    { role: "user", content: `They asked for: ${request}\n\nOn the card about: ${about}` },
  ]);
  const named = (Array.isArray(r.entries) ? r.entries : []).filter((e) => typeof e?.name === "string" && e.name.trim()).slice(0, SET_MAX);
  if (!named.length) throw new Error(`Couldn't put together a set for "${request}".`);
  const entries = await Promise.all(
    named.map(async (e): Promise<SetEntry> => {
      const w = await wikiFor(e.name!.trim(), e.wikipedia?.trim());
      const note = e.note?.trim().slice(0, 300) || undefined;
      if (!w) return { title: e.name!.trim().slice(0, 120), subtitle: e.subtitle?.trim().slice(0, 80) || undefined, note, unverified: true };
      return {
        // "The Fall (band)" is shown as "The Fall": the link keeps the article's own title.
        title: w.title!.replace(/\s*\([^)]*\)$/, ""),
        subtitle: e.subtitle?.trim().slice(0, 80) || w.description?.slice(0, 80),
        note,
        image: w.thumbnail?.source ?? (await firstFigure(w.title!)),
        url: w.content_urls?.desktop?.page ?? `${WIKI}/wiki/${encodeURIComponent(w.title!.replace(/ /g, "_"))}`,
        extract: w.extract?.slice(0, 600),
      };
    }),
  );
  // The same article twice (two names for one band) is one tile.
  const seen = new Set<string>();
  const unique = entries.filter((e) => (e.url ? !seen.has(e.url) && seen.add(e.url) : true));
  return { title: String(r.title ?? request).slice(0, 120), caption: r.caption ? String(r.caption).slice(0, 300) : undefined, entries: unique };
}
