// Maps a reader asks for. The model picks what to show (places, in order if it's a route, and which
// countries or regions to outline) and says roughly where each is; OpenStreetMap's geocoder places
// them, and its boundaries draw the outlines. Where the geocoder's answer is far from what the model
// expected (Paris, Texas for Paris), the model's fuller name is tried, then its own guess, flagged.
import type { PlaceMap } from "../shared/canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";

const UA = "Librarian/1.0 (study canvas)";
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) && v.trim() ? Number(v) : undefined);

const MAP = `You make a map for a reader studying a topic: the places that matter to what they asked, in the context of the card.
For each place give "name" (as it should be labeled), "query" (an unambiguous name a geocoder would find TODAY: "Vukovar, Croatia",
"Sarajevo, Bosnia and Herzegovina"; for a historical place, its modern equivalent), your best "lat" and "lon", a short "note"
(what happened there, or why it matters: one sentence), and a "group" when places fall into kinds.
Set "route": true only when the places are a sequence to be joined in order (a journey, a campaign, a trade route).
"areas": countries or regions worth outlining (as named today: "Slovenia", "Kosovo"), with a group each; leave it empty when outlines don't help.
At most 30 places and 12 areas.
Return JSON only:
{"title": "...", "caption": "one or two sentences on how to read it", "route": false,
 "places": [{"name": "...", "query": "...", "lat": 0, "lon": 0, "note": "...", "group": "..."}], "areas": [{"name": "...", "group": "..."}]}`;

let last = 0;
/** One request a second, as the public geocoder asks. */
async function nominatim(params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const q = new URLSearchParams({ format: "jsonv2", limit: "1", ...params });
  const r = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`geocoder answered ${r.status}`);
  return (await r.json()) as Record<string, unknown>[];
}

/** Kilometers between two points. */
function km(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export async function makeMap(request: string, about: string, previous?: PlaceMap, onStage?: (s: "searching") => void): Promise<PlaceMap> {
  const r = await chatJson<Record<string, unknown>>((await loadConfig()).llm, [
    { role: "system", content: MAP },
    {
      role: "user",
      content: [
        `They asked for: ${request}`,
        `The card it's about: ${about.slice(0, 2000)}`,
        previous && `The map they had, to change as they ask:\n${JSON.stringify({ title: previous.title, route: previous.route, places: previous.places.map((p) => ({ name: p.name, note: p.note, group: p.group })), areas: previous.areas?.map((a) => a.name) })}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]);
  onStage?.("searching");
  const places: PlaceMap["places"] = [];
  const missing: string[] = [];
  for (const item of (Array.isArray(r.places) ? r.places : []).slice(0, 30)) {
    const p = item as Record<string, unknown>;
    const name = str(p.name).slice(0, 80);
    if (!name) continue;
    const guess = num(p.lat) !== undefined && num(p.lon) !== undefined ? ([num(p.lat)!, num(p.lon)!] as [number, number]) : null;
    let at: [number, number] | null = null;
    for (const q of [...new Set([str(p.query), name].filter(Boolean))]) {
      try {
        const hit = (await nominatim({ q }))[0];
        const found: [number, number] | null = hit ? [Number(hit.lat), Number(hit.lon)] : null;
        // Trust the geocoder unless it went somewhere else entirely.
        if (found && (!guess || km(found, guess) < 600)) {
          at = found;
          break;
        }
      } catch {
        // Try the next name, then fall back to the guess.
      }
    }
    const base = { name, ...(str(p.note) ? { note: str(p.note).slice(0, 300) } : {}), ...(str(p.group) ? { group: str(p.group).slice(0, 40) } : {}) };
    if (at) places.push({ ...base, lat: at[0], lon: at[1] });
    else if (guess) places.push({ ...base, lat: guess[0], lon: guess[1], approximate: true });
    else missing.push(name);
  }
  const areas: NonNullable<PlaceMap["areas"]> = [];
  for (const item of (Array.isArray(r.areas) ? r.areas : []).slice(0, 12)) {
    const a = (typeof item === "string" ? { name: item } : item) as Record<string, unknown>;
    const name = str(a.name);
    if (!name) continue;
    try {
      const hit = (await nominatim({ q: name, polygon_geojson: "1", polygon_threshold: "0.01" }))[0];
      const geometry = hit?.geojson as { type?: string } | undefined;
      if (geometry && /Polygon/.test(geometry.type ?? "")) areas.push({ name: name.slice(0, 80), ...(str(a.group) ? { group: str(a.group).slice(0, 40) } : {}), geometry });
      else missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  if (!places.length && !areas.length) throw new Error("Couldn't place anything on a map for that. Try asking differently.");
  return {
    title: str(r.title).slice(0, 120) || request,
    caption: str(r.caption).slice(0, 400) || undefined,
    places,
    ...(r.route === true && places.length > 1 ? { route: true } : {}),
    ...(areas.length ? { areas } : {}),
    ...(missing.length ? { missing } : {}),
  };
}
