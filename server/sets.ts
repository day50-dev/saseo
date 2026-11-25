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

/** The Wikipedia article for an entry: by the title the model gave, else the best search hit for its name. */
export async function wikiFor(name: string, title?: string, context = ""): Promise<Summary | null> {
  const usable = (s: Summary | null) => (s && s.type !== "disambiguation" && s.title ? s : null);
  const direct = title ? usable(await summary(title)) : null;
  if (direct) return direct;
  const q = new URLSearchParams({ action: "query", list: "search", srsearch: `${name} ${context}`.trim(), srlimit: "1", format: "json" });
  const hit = (await getJson<{ query?: { search?: { title: string }[] } }>(`${WIKI}/w/api.php?${q}`))?.query?.search?.[0]?.title;
  return hit ? usable(await summary(hit)) : null;
}

/** Makes a set for `request` about `about`: named by the model, checked against Wikipedia. */
export async function makeSet(request: string, about: string): Promise<{ title: string; caption?: string; entries: SetEntry[] }> {
  const r = await chatJson<{ title?: string; caption?: string; entries?: { name?: string; wikipedia?: string; subtitle?: string; note?: string }[] }>((await loadConfig()).llm, [
    { role: "system", content: SET },
    { role: "user", content: `They asked for: ${request}\n\nOn the card about: ${about}` },
  ]);
  const named = (Array.isArray(r.entries) ? r.entries : []).filter((e) => typeof e?.name === "string" && e.name.trim()).slice(0, SET_MAX);
  if (!named.length) throw new Error(`Couldn't put together a set for "${request}".`);
  const context = String(r.title ?? "").slice(0, 60);
  const entries = await Promise.all(
    named.map(async (e): Promise<SetEntry> => {
      const w = await wikiFor(e.name!.trim(), e.wikipedia?.trim(), context);
      const note = e.note?.trim().slice(0, 300) || undefined;
      if (!w) return { title: e.name!.trim().slice(0, 120), subtitle: e.subtitle?.trim().slice(0, 80) || undefined, note, unverified: true };
      return {
        // "The Fall (band)" is shown as "The Fall": the link keeps the article's own title.
        title: w.title!.replace(/\s*\([^)]*\)$/, ""),
        subtitle: e.subtitle?.trim().slice(0, 80) || w.description?.slice(0, 80),
        note,
        image: w.thumbnail?.source,
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
