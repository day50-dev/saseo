// Pictures: for "show me what it looked like", "the model sheets over the years", "pictures of…".
// Candidates come from Wikimedia Commons (described, dated, licensed) and from the figures on pages
// the search finds (where a subject's own artwork usually is). The model picks and captions them from
// what each one is said to show; each picked image is then fetched and kept, so the gallery doesn't
// break when a site moves it, and so any of them can be put on the canvas and boxed like a page.
import type { FoundSource, GalleryImage } from "../shared/canvas.ts";
import { saveAsset } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";
import { parseHTML } from "linkedom";

const UA = "Librarian/1.0 (study canvas)";
export const GALLERY_MAX = 12;
/** More are picked than shown: looking at them drops the ones that turn out not to fit. */
const GALLERY_PICK = 18;
const PER_PAGE = 12;
const MIN_SIDE = 240;
const MAX_BYTES = 8_000_000;

export interface Candidate {
  url: string;
  /** What the image is said to show: its alt text, caption or description. */
  said: string;
  /** The page it's on, and that page's title. */
  page: string;
  pageTitle: string;
  site: string;
  when?: string;
  credit?: string;
}

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Images on Wikimedia Commons matching the query, with their descriptions and dates. */
export async function commonsCandidates(query: string, limit = 16): Promise<Candidate[]> {
  const api = new URL(process.env.LIBRARIAN_COMMONS ?? "https://commons.wikimedia.org/w/api.php");
  for (const [k, v] of Object.entries({
    action: "query",
    format: "json",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: query,
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiurlwidth: "1200",
    origin: "*",
  }))
    api.searchParams.set(k, v);
  try {
    // Commons sometimes turns a burst of searches away for a moment: once more, after a pause.
    let r = await fetch(api, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
    if (!r?.ok) {
      await new Promise((done) => setTimeout(done, 1500 + Math.random() * 1500));
      r = await fetch(api, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
    }
    if (!r.ok) return [];
    const data = (await r.json()) as {
      query?: {
        pages?: Record<
          string,
          {
            title: string;
            index?: number;
            imageinfo?: {
              url: string;
              thumburl?: string;
              mime: string;
              width: number;
              height: number;
              descriptionurl: string;
              extmetadata?: Record<string, { value?: string }>;
            }[];
          }
        >;
      };
    };
    const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const out: Candidate[] = [];
    for (const p of pages) {
      const ii = p.imageinfo?.[0];
      if (!ii || !/^image\/(jpeg|png|webp|gif)$/.test(ii.mime) || Math.min(ii.width, ii.height) < MIN_SIDE) continue;
      const meta = ii.extmetadata ?? {};
      const said = strip(meta.ImageDescription?.value ?? "") || p.title.replace(/^File:/, "").replace(/\.\w+$/, "");
      const when = strip(meta.DateTimeOriginal?.value ?? "").slice(0, 40) || undefined;
      const artist = strip(meta.Artist?.value ?? "").slice(0, 80);
      const license = strip(meta.LicenseShortName?.value ?? "");
      out.push({
        url: ii.thumburl ?? ii.url,
        said: said.slice(0, 300),
        page: ii.descriptionurl,
        pageTitle: p.title,
        site: "Wikimedia Commons",
        when,
        credit: [artist, license].filter(Boolean).join(", ") || undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Not pictures of the subject: site furniture.
const FURNITURE = /logo|icon|sprite|avatar|badge|button|banner|pixel|spacer|tracking|placeholder|emoji|social|share|gravatar|\.svg($|\?)/i;

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** The pictures on a page: lazy-loaded ones included, each with what it's said to show. */
export async function pageCandidates(link: string): Promise<Candidate[]> {
  try {
    const r = await fetch(link, { headers: { "User-Agent": BROWSER_UA, Accept: "text/html" }, signal: AbortSignal.timeout(12_000) });
    if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "")) return [];
    return imagesInHtml(await r.text(), r.url || link);
  } catch {
    return [];
  }
}

/** The best address an <img> offers: a lazy loader's real one, or the largest in its srcset. */
function imgSrc(img: Element): string {
  const srcset = img.getAttribute("data-srcset") || img.getAttribute("srcset") || "";
  const largest = srcset
    .split(",")
    .map((part) => part.trim().split(/\s+/))
    .filter(([u]) => u)
    .sort((a, b) => (parseFloat(b[1] ?? "0") || 0) - (parseFloat(a[1] ?? "0") || 0))[0]?.[0];
  const src = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || largest || img.getAttribute("src") || "";
  return src.startsWith("data:") ? largest ?? "" : src;
}

export function imagesInHtml(html: string, pageUrl: string): Candidate[] {
  const { document } = parseHTML(html);
  const pageTitle = (document.querySelector("meta[property='og:title']")?.getAttribute("content") || document.querySelector("title")?.textContent || "").trim().slice(0, 200);
  const site = (document.querySelector("meta[property='og:site_name']")?.getAttribute("content") || new URL(pageUrl).hostname.replace(/^www\./, "")).trim();
  for (const el of [...document.querySelectorAll("header, footer, nav, aside, script, style, noscript")]) el.remove();
  const out: Candidate[] = [];
  for (const img of [...document.querySelectorAll("img")]) {
    const raw = imgSrc(img);
    if (!raw) continue;
    let url: string;
    try {
      url = new URL(raw, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(url) || FURNITURE.test(url)) continue;
    const w = Number(img.getAttribute("width")) || 0;
    const h = Number(img.getAttribute("height")) || 0;
    if ((w && w < 150) || (h && h < 150)) continue;
    // What it shows: its caption, its alt text, or failing those the words around it.
    const caption = img.closest("figure")?.querySelector("figcaption")?.textContent ?? "";
    const alt = img.getAttribute("alt") || img.getAttribute("title") || "";
    let around = "";
    for (let el = img.parentElement, i = 0; el && i < 4 && around.length < 15; el = el.parentElement, i++) around = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const said = [caption, alt].map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).join(" — ") || (around ? `(near: ${around.slice(0, 200)})` : "(no description)");
    out.push({ url, said: said.slice(0, 300), page: pageUrl, pageTitle, site });
  }
  return out;
}

const QUERIES = `A reader on a study canvas asked to see pictures. Write two searches for them.
"web": a web search that finds pages showing these pictures (galleries, museum and archive pages, articles about them).
"commons": one to eight searches for Wikimedia Commons, which matches file descriptions: each two to four words, no
"pictures" or "images". The bare subject ("Mickey Mouse", "Brutalist architecture"), or when they want several artists,
works or things, one search for each of the main ones ("Botticelli Birth of Venus", "Raphael School of Athens").
Return JSON only: {"web": "...", "commons": ["...", "..."]}`;

const PICK = `A reader on a study canvas asked to see pictures. You are given numbered candidate images, each with what it
is said to show (its alt text, caption or description) and the page it's on. Choose the ones that best show what they asked
for, at most ${GALLERY_PICK} and 8 to 12 when there are that many good ones (one of each work or thing they named, if it's
there): real artwork, photographs, drawings, model sheets, scans and figures of the subject itself.
Leave out logos, site decoration, ads, author photos, merchandise and anything only loosely related. Don't choose two that
are surely the same picture. Draw from several sources when they serve equally well, so it isn't one site's selection.
When they asked how something changed over time, order them by date, oldest first; otherwise
most useful first. For each chosen image: its number, a caption of one plain sentence saying what it shows (from what it
is said to show; don't invent detail), and "when" (a year or period) only if the candidate says so.
Also a short title for the gallery and a one-sentence caption.
Return JSON only: {"title": "...", "caption": "...", "images": [{"n": 1, "caption": "...", "when": "1928"}]}`;

/** Fetches an image and keeps it, if it's a real picture of a useful size. */
async function keep(c: Candidate): Promise<{ asset: string; w: number; h: number; mime: string; bytes: Buffer } | null> {
  try {
    const r = await fetch(c.url, { headers: { "User-Agent": UA, Referer: c.page, Accept: "image/*" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_BYTES) return null;
    const size = imageSize(bytes);
    if (!size || Math.min(size.w, size.h) < MIN_SIDE) return null;
    return { asset: await saveAsset(bytes, mime), ...size, mime, bytes };
  } catch {
    return null;
  }
}

const LOOK_BATCH = 4;

const LOOK = `A reader on a study canvas asked to see pictures, and these images were found for them, each with what its
source says about it. Look at each image, in order. For each: "keep" (false if it doesn't show what they asked for: a
logo, decoration, an unrelated photo, a blank or broken image), "caption" (one plain sentence on what is visibly in it,
using the source's words for names and dates; don't guess what you can't see or read), and "when" (a year or period)
only if the image or its source shows it.
Return JSON only: {"images": [{"keep": true, "caption": "...", "when": "1940"}]}, one entry per image, in order.`;

/** What the model sees in each picture; an empty answer (the model can't see, or failed) leaves them as picked. */
async function look(
  request: string,
  batch: { p: { caption?: string; when?: string }; c: Candidate; got: { mime: string; bytes: Buffer } }[],
): Promise<({ keep?: boolean; caption?: string; when?: string } | undefined)[]> {
  try {
    const config = await loadConfig();
    const content = [
      { type: "text" as const, text: `They asked for: ${request}\n\n${batch.map(({ p, c }, i) => `Image ${i + 1}: its source says "${c.said}"${p.caption ? `; picked as "${p.caption}"` : ""} (${c.site})`).join("\n")}` },
      ...batch.map(({ got }) => ({ type: "image_url" as const, image_url: { url: `data:${got.mime};base64,${got.bytes.toString("base64")}` } })),
    ];
    const r = await chatJson<{ images?: { keep?: boolean; caption?: string; when?: string }[] }>(config.llm, [
      { role: "system", content: LOOK },
      { role: "user", content },
    ]);
    return batch.map((_, i) => {
      const x = r.images?.[i];
      return x ? { keep: x.keep !== false, caption: String(x.caption ?? "").trim() || undefined, when: String(x.when ?? "").trim() || undefined } : undefined;
    });
  } catch {
    return batch.map(() => undefined);
  }
}

/** An image's width and height from its header: PNG, GIF, JPEG or WebP. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length < 30) return null;
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers carry the size (not DHT, JPG or DAC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/**
 * A gallery for what was asked: candidates from Commons and from the pages found, picked and captioned
 * by the model, then fetched and kept. `search` is the librarian's web search.
 */
export async function makeGallery(
  request: string,
  about: string,
  search: (q: string) => Promise<FoundSource[]>,
  onStage?: (stage: "searching" | "writing") => void,
): Promise<{ title: string; caption?: string; images: GalleryImage[] }> {
  onStage?.("searching");
  const config = await loadConfig();
  let query = request;
  let subjects: string[] = [];
  try {
    const q = await chatJson<{ web?: string; commons?: unknown }>(config.llm, [
      { role: "system", content: QUERIES },
      { role: "user", content: `The card is about: ${about.slice(0, 1000)}\n\nThey asked for: ${request}` },
    ]);
    query = String(q.web ?? "").trim() || request;
    subjects = (Array.isArray(q.commons) ? q.commons : [q.commons]).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 8);
  } catch {}
  // Commons matches file descriptions, so it gets short searches of its own: the bare subject, or
  // one per artist or work asked for.
  const [found, ...byCommons] = await Promise.all([
    search(query).catch(() => [] as FoundSource[]),
    ...(subjects.length ? subjects : [query]).map((q) => commonsCandidates(q, subjects.length > 1 ? 6 : 16)),
  ]);
  // Taken in turns, so each search gets its best ones in.
  const commons: Candidate[] = [];
  for (let i = 0; byCommons.some((l) => l[i]); i++) for (const l of byCommons) if (l[i]) commons.push(l[i]);
  // A few from each page: one big gallery page mustn't make the whole gallery.
  const pages = (await Promise.all(found.slice(0, 6).map((f) => pageCandidates(f.url)))).map((list) => list.slice(0, PER_PAGE));
  // The pages' own figures first (they're about this), then Commons; one of each address.
  const seen = new Set<string>();
  // Room for both: a page with many figures mustn't crowd Commons out.
  const fresh = (list: Candidate[]) => list.filter((c) => !seen.has(c.url) && (seen.add(c.url), true));
  const candidates = [...fresh(pages.flat()).slice(0, 36), ...fresh(commons).slice(0, 32)];
  if (!candidates.length) throw new Error(`No pictures found for "${query}". Try asking differently.`);

  onStage?.("writing");
  const list = candidates.map((c, i) => `${i + 1}. ${c.said}${c.when ? ` (dated ${c.when})` : ""} — on "${c.pageTitle}" (${c.site})`).join("\n");
  const r = await chatJson<{ title?: string; caption?: string; images?: { n?: number; caption?: string; when?: string }[] }>(config.llm, [
    { role: "system", content: PICK },
    { role: "user", content: `They asked for: ${request}\n\nThe card it's about:\n${about.slice(0, 1500)}\n\nCandidates:\n${list}` },
  ]);
  const picked = (r.images ?? [])
    .map((p) => ({ p, c: candidates[(Number(p.n) || 0) - 1] }))
    .filter((x): x is { p: NonNullable<typeof r.images>[number]; c: Candidate } => Boolean(x.c))
    .slice(0, GALLERY_PICK);
  const kept = await Promise.all(picked.map(async ({ p, c }) => ({ p, c, got: await keep(c) })));
  // The same picture from two places is kept once (its asset is its content hash).
  const assets = new Set<string>();
  const got = kept.filter((k): k is typeof k & { got: NonNullable<typeof k.got> } => Boolean(k.got) && !assets.has(k.got!.asset) && (assets.add(k.got!.asset), true));
  // Then the model looks at each one: what's really in it, and whether it shows what was asked.
  const seen4 = await Promise.all(
    Array.from({ length: Math.ceil(got.length / LOOK_BATCH) }, (_, i) => got.slice(i * LOOK_BATCH, (i + 1) * LOOK_BATCH)).map((batch) => look(request, batch)),
  );
  const looks = seen4.flat();
  const images: GalleryImage[] = [];
  got.forEach(({ p, c, got: g }, i) => {
    const seen = looks[i];
    if (seen?.keep === false || images.length >= GALLERY_MAX) return;
    const when = seen?.when || p.when;
    images.push({
      asset: g.asset,
      w: g.w,
      h: g.h,
      caption: (seen?.caption || String(p.caption ?? "").trim() || c.said).slice(0, 300),
      ...(when ? { when: String(when).slice(0, 40) } : {}),
      page: c.page,
      site: c.site,
      ...(c.credit ? { credit: c.credit } : {}),
    });
  });
  console.log(`gallery "${query}" / Commons ${JSON.stringify(subjects)}: ${candidates.length} candidates (${commons.length} from Commons), ${picked.length} picked, ${got.length} fetched, ${images.length} kept`);
  if (images.length < 2) throw new Error(`Couldn't fetch enough pictures for "${query}". Try asking differently.`);
  return { title: String(r.title ?? "").trim().slice(0, 120) || `Pictures: ${request}`, caption: String(r.caption ?? "").trim().slice(0, 300) || undefined, images };
}
