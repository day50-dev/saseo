// The librarian's loop for one card: read the region, go fish, write a descending
// explanation from what was found, then check that it doesn't climb.
import { addNote } from "./notes.ts";
import { makeSet } from "./sets.ts";
import { CARD_WIDTH, SOURCE_WIDTH, EXTENSION_SHAPES, RETRY_TRIES, retryDelay, type Extension, type ExtensionShape, type PageSection, paragraphs, type CardItem, type FoundSource, type ImageItem, type Item, type ObjectKind, type Paper, type Rect, type Register, type RegisterNote, type Sem, type Video } from "../shared/canvas.ts";
import { SEARCHER_IDS } from "../shared/providers.ts";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assetPath, type CanvasStore, getCanvasInfo, newId, onResume } from "./canvas.ts";
import { diagramEndpoint, loadConfig } from "./config.ts";
import { logCourses } from "./curriculum.ts";
import { snap } from "./snap.ts";
import { exampleNotebook } from "./notebooks.ts";
import { bestRead, editVersion, hashText, pageVersion, readOf, remember } from "./pagecache.ts";
import { chat, chatJson, chatStream, decideChoice, decideYesNo, type Message, systemOneConfigured } from "./llm.ts";
import { arxivPaper, parseArxivId, searchArxiv } from "./arxiv.ts";
import { readPage as readWebPage } from "./pages.ts";
import { runSearch } from "./providers.ts";
import { partialSvg, sanitizeSvg, svgLabels } from "./svg.ts";
import { makeGraph, makePlot, makeTable } from "./figures.ts";
import { makeMap } from "./maps.ts";

const IDENTIFY = `You help a curious, intelligent reader who is not a specialist. They selected part of an image because they don't understand it.
The first image is the whole page with a red rectangle around their selection. The second image is the selection enlarged.
Return JSON only, no prose:
{"transcription": "the exact text or math inside the rectangle (math as LaTeX)",
 "subject": "short name of the concept they are asking about, 2-6 words, as a reader would say it",
 "topic": "what the whole page is about, a few words",
 "pageText": "the full text of the WHOLE page in reading order (math as LaTeX), so later steps know the context",
 "terms": [{"text": "a word, phrase or symbol INSIDE the rectangle, copied as written",
            "register": "term (a technical term with a strict definition) | idiom (an insider phrase or move with a precise meaning rarely spelled out) | casual (everyday words used loosely) | notation (ONLY a symbol or formula visibly used loosely: in quote marks, with ≈ or "morally"; a precise symbol such as L^1(R^2) or a defined function is a term)",
            "means": "for casual words or notation: what is actually meant; for a term or idiom: a one-line plain gloss",
            "field": "for a term borrowed from another area, that area; otherwise empty"}],
 "searchQuery": "a short web search query, 2-6 plain words, for BEGINNER material (intro lecture notes, textbook chapters, videos) on the most general idea behind the subject. Never the paper's title, its notation, or terms specific to this page."}`;

const EXPLAIN = `You are a research librarian with unlimited time, helping a curious, intelligent reader who is not a specialist in this field.
Your explanation will be drawn as a diagram, not printed as paragraphs, so you return its STRUCTURE: short pieces and how they connect.
Rules:
- Descend, never climb. Use ideas MORE general and familiar than the subject. Never define it in terms more specialized than itself. If a technical term is unavoidable, it must be more basic than the subject, and you gloss it in plain words.
- Start with why: the question or problem the idea answers, so it doesn't feel arbitrary.
- If the reader has said they are new to the field, never use a technical term bare: say it in plain words and list it as a
  stand-in, or gloss it in the same sentence ("clathrin, a protein that forms a cage around the membrane"). Lean on
  the plain picture; the terms are labels for it, not the explanation.
- Be faithful. Don't invent facts. Where a numbered source supports a claim, cite it as [n]. Standard background needs no citation.
- Every piece is short: one sentence, at most about 20 words. Plain text. Write math as LaTeX between \\( and \\), e.g. \\(\\mathrm{id}_B \\otimes \\Delta\\), never bare symbols with flattened subscripts.
Return JSON only, no prose:
{"why": ["2 to 4 steps forming a chain: the problem, then each step following from the one before"],
 "what": {"gist": "one sentence: what it is, in familiar terms", "details": ["0 to 3 further facts about it"]},
 "parts": [{"symbol": "a piece of the formula or name, copied as written", "meaning": "what that piece is, 2-6 words", "note": "one short gloss"}],
 "together": "if there are parts: what they add up to, one sentence; otherwise empty",
 "here": ["1 to 3 steps: how it is used on this page specifically"],
 "name": "what the words of its name mean, or an empty string if that isn't illuminating",
 "terms": ["every technical term of art you used above, copied exactly as you wrote it"],
 "standIns": [{"phrase": "an everyday phrase you used above in place of a technical term, copied exactly", "concept": "the technical term it stands for"}]}
Mark the register honestly: a reader can't otherwise tell your strict terms from your plain-language stand-ins.
Use "parts" only when the subject is a formula or a compound whose pieces each mean something (2 to 5 parts); otherwise return [].`;

const CLIMB_QUESTION =
  "Does this explanation rely on terms or ideas that are more specialized or obscure than its subject, without explaining them in plain words?";

async function ancestry(store: CanvasStore, card: CardItem): Promise<{ path: string[]; topic?: string; root?: CardItem }> {
  const path: string[] = [];
  let topic: string | undefined;
  let root: CardItem | undefined;
  let cur: Item | undefined = await store.findItem(card.parentId);
  while (cur?.kind === "card") {
    if (cur.subject) path.unshift(cur.subject);
    topic ??= cur.topic;
    root = cur;
    cur = await store.findItem(cur.parentId);
  }
  return { path, topic: topic ?? root?.topic, root };
}

/**
 * A long page cut to what fits in a prompt: the part around `near` (the line the reader selected
 * from) when it can be found, else the start. Short pages pass through whole.
 */
function excerpt(text: string, near = "", max = 16_000): string {
  if (text.length <= max) return text;
  let at = -1;
  const probe = near.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
  if (probe) {
    // The page with whitespace squashed, and where each of its characters came from.
    let flat = "";
    const from: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const space = /\s/.test(text[i]);
      if (space && flat.endsWith(" ")) continue;
      flat += space ? " " : text[i].toLowerCase();
      from.push(i);
    }
    const i = flat.indexOf(probe);
    if (i >= 0) at = from[i];
  }
  if (at < 0) return `${text.slice(0, max)}\n…`;
  const start = Math.max(0, Math.min(at - max / 2, text.length - max));
  return `${start > 0 ? "…\n" : ""}${text.slice(start, start + max)}${start + max < text.length ? "\n…" : ""}`;
}

/** A card's explanation as plain text: the structure for newer cards, paragraphs for older ones. */
function cardText(c: CardItem): string {
  if (c.origin) return [c.sem ? semText(c.sem) : "", excerpt(c.pageText ?? c.origin.title)].filter(Boolean).join("\n\n");
  if (c.sem) {
    const standIns = (c.sem.standIns ?? []).map((s) => `"${s.phrase}" stands for ${s.concept}`);
    return [semText(c.sem), standIns.length ? `Plain-language stand-ins used: ${standIns.join("; ")}` : ""].filter(Boolean).join("\n");
  }
  if (c.facets) return [c.facets.why, c.facets.what, c.facets.how].filter(Boolean).join("\n");
  return "";
}

/**
 * Everything the librarian knows about how the reader got to this card: what they boxed on the
 * page, every card on the way down with its gist, and the full explanation they selected from.
 */
async function trail(store: CanvasStore, card: CardItem): Promise<string> {
  const chain: CardItem[] = [];
  let cur: Item | undefined = await store.findItem(card.parentId);
  while (cur?.kind === "card") {
    chain.unshift(cur);
    cur = await store.findItem(cur.parentId);
  }
  if (!chain.length) return "";
  const root = chain[0];
  const parent = chain[chain.length - 1];
  const lines = [
    `The reader boxed this on a page${root.topic ? ` about ${root.topic}` : ""}${root.transcription ? `: ${root.transcription}` : ""}`,
    root.pageText
      ? `The page${root.pageText.length > 16_000 ? " (the part around what they selected)" : ""} reads:\n${excerpt(root.pageText, chain.length === 1 ? card.context : "")}`
      : "",
    `Then, step by step, they asked about:`,
    ...chain.map((c, i) => `${i + 1}. ${c.subject ?? c.selection ?? "?"}${c.sem?.what.gist ? `: ${c.sem.what.gist}` : ""}`),
    // Selecting straight from the page: the page above is already what they selected from.
    parent === root && root.pageText
      ? parent.sem
        ? `The page's shapes, which they may have selected from:\n${semText(parent.sem)}`
        : ""
      : `The full explanation of "${parent.subject ?? "the previous card"}" that they selected words from:\n${cardText(parent)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

function mergeHits(results: Awaited<ReturnType<typeof runSearch>>, max = 6): FoundSource[] {
  const lists = Object.entries(results)
    .filter(([, r]) => r?.ok)
    .map(([id, r]) => r!.hits.map((h) => ({ ...h, searcher: id })));
  const seen = new Set<string>();
  const out: FoundSource[] = [];
  // Round-robin so one searcher can't crowd out the others.
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const h = l[i];
      if (!h || out.length >= max) continue;
      // The same document often comes back under several URLs (abs/html/pdf); match on title too.
      const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      const title = h.title.trim().toLowerCase();
      if (seen.has(key) || (title && seen.has(`t:${title}`))) continue;
      seen.add(key);
      if (title) seen.add(`t:${title}`);
      out.push({ n: out.length + 1, url: h.url, title: h.title, snippet: h.snippet.slice(0, 600), searcher: h.searcher });
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(str).filter(Boolean).slice(0, max);

/** Accepts whatever the model returned and keeps only well-formed pieces of a Sem. */
/** The explanation inside a reply that wrapped it ({"explanation": {"why": …}}), or the reply itself. */
function unwrapSem(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.why || raw.what) return raw;
  for (const v of Object.values(raw)) {
    if (v && typeof v === "object" && !Array.isArray(v) && ((v as Record<string, unknown>).why || (v as Record<string, unknown>).what)) return v as Record<string, unknown>;
  }
  return raw;
}

function cleanSem(reply: Record<string, unknown>, maxHere = 3): Sem {
  const raw = unwrapSem(reply);
  const what = (raw.what ?? {}) as Record<string, unknown>;
  const parts = (Array.isArray(raw.parts) ? raw.parts : [])
    .map((p) => p as Record<string, unknown>)
    .map((p) => ({ symbol: str(p.symbol), meaning: str(p.meaning), note: str(p.note) }))
    .filter((p) => p.symbol && p.meaning)
    .slice(0, 5);
  return {
    why: strs(raw.why, 4),
    what: { gist: typeof raw.what === "string" ? str(raw.what) : str(what.gist), details: strs(what.details, 3) },
    parts: parts.length >= 2 ? parts : [],
    together: parts.length >= 2 ? str(raw.together) : "",
    here: strs(raw.here ?? raw.how, maxHere),
    name: str(raw.name),
    terms: strs(raw.terms, 12),
    standIns: (Array.isArray(raw.standIns) ? raw.standIns : [])
      .map((s) => s as Record<string, unknown>)
      .map((s) => ({ phrase: str(s.phrase), concept: str(s.concept) }))
      .filter((s) => s.phrase && s.concept)
      .slice(0, 8),
  };
}

function cleanTerms(raw: unknown): RegisterNote[] {
  const out: RegisterNote[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const t = item as Record<string, unknown>;
    // Models sometimes echo the option list ("term (a technical term…)"); keep the first word.
    const register = str(t.register).split(/[\s(|]/)[0];
    const text = str(t.text);
    if (!text || !isRegister(register)) continue;
    out.push({ text, register, means: str(t.means), field: str(t.field) || undefined });
  }
  return out.slice(0, 10);
}

const semText = (s: Sem) =>
  [...s.why, s.what.gist, ...s.what.details, ...s.parts.map((p) => `${p.symbol}: ${p.meaning}, ${p.note}`), s.together, ...s.here]
    .filter(Boolean)
    .join("\n");

async function write(
  store: CanvasStore,
  card: CardItem,
  subject: string,
  quoted: string,
  topic: string | undefined,
  path: string[],
  sources: FoundSource[],
  context = "",
  flow = false,
) {
  const config = await loadConfig();
  const told = await readerNotes(store);
  const lines = [
    `Subject: ${subject}`,
    `What the reader selected: ${quoted}`,
    told ? `${told}\nPitch the explanation to that: where they are starting from and what they are trying to do.` : "",
    context ? `How they got here:\n${context}` : "",
    topic ? `The page is about: ${topic}` : "",
    path.length
      ? `The reader got here by asking about: ${path.join(" → ")} → ${subject}. They don't know these yet, so don't lean on them.`
      : "",
    sources.length
      ? `Sources found:\n${sources.map((s) => `[${s.n}] ${s.title} (${s.url})\n${s.snippet}`).join("\n\n")}`
      : "No sources were found; rely on standard knowledge.",
  ].filter(Boolean);
  // A typed question has no page for "how it's used here"; that slot holds how it unfolds instead.
  const system = flow
    ? EXPLAIN.replace(
        ' "here": ["1 to 3 steps: how it is used on this page specifically"],',
        ' "here": ["3 to 6 steps: how it unfolds, in order: the process, mechanism or sequence of events, one plain step each. For a cycle, end where it begins again."],',
      )
    : EXPLAIN;
  const messages: Message[] = [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n\n") },
  ];
  const first = await chatJson<Record<string, unknown>>(config.llm, messages);
  let sem = cleanSem(first, flow ? 6 : 3);
  if (!sem.why.length && !sem.what.gist) {
    console.warn("explanation without why or what; the reply had:", JSON.stringify(first).slice(0, 600));
    throw new Error("The model's answer had no why and no what");
  }
  let climb: number | undefined;
  let rewritten = false;

  if (systemOneConfigured(config.systemOne)) {
    await store.update(card.id, { stage: "checking", sem, sources });
    const check = (s: Sem) => decideYesNo(config.systemOne, { subject, explanation: semText(s) }, CLIMB_QUESTION);
    try {
      climb = await check(sem);
      if (climb >= 0.5) {
        messages.push(
          { role: "assistant", content: JSON.stringify(sem) },
          {
            role: "user",
            content:
              "A check found this climbs: it leans on terms more specialized than the subject. Rewrite it using only more familiar ideas, glossing anything technical in everyday words. Same JSON shape.",
          },
        );
        const second = cleanSem(await chatJson<Record<string, unknown>>(config.llm, messages), flow ? 6 : 3);
        const secondClimb = await check(second);
        rewritten = true;
        // Keep whichever version the check judged to climb less.
        if (secondClimb < climb) {
          sem = second;
          climb = secondClimb;
        }
      }
    } catch {
      // The check is advisory; a failure leaves the draft as written.
    }
  }
  await store.update(card.id, { stage: "done", sem, sources, climb, rewritten, ...(flow ? { flow: true } : {}) });
  void mapCourses(store, card.id, subject, sources);
}

/**
 * Notes which courses teach (or assume) the subject, from the pages found for it plus a search
 * aimed at course material, and shows them on the card. Feeds the shared course map.
 */
export async function mapCourses(store: CanvasStore, cardId: string, subject: string, sources: FoundSource[]) {
  try {
    const more = await search(`${subject} course syllabus lecture notes`).catch(() => []);
    const seen = new Set(sources.map((s) => s.url));
    const pages = [...sources, ...more.filter((m) => !seen.has(m.url))].map((p, i) => ({ ...p, n: i + 1 }));
    const taught = await logCourses(subject, pages);
    // Saved even when empty, so the card isn't mapped again.
    await store.update(cardId, { taught: taught.slice(0, 12) });
  } catch {
    // The course map is a side benefit; a failure just leaves the card without it.
    await store.update(cardId, { taught: [] });
  }
}

async function search(query: string): Promise<FoundSource[]> {
  const config = await loadConfig();
  const enabled = SEARCHER_IDS.filter((id) => config.searchers[id].enabled);
  if (!enabled.length) return [];
  const found = mergeHits(await runSearch(config, query, enabled, 4));
  // A PDF often comes back titled with its own address; give it a title a person would recognize.
  return Promise.all(
    found.map(async (f) => {
      // arXiv knows its papers' titles; a PDF's first line there is only arXiv's stamp.
      const arxiv = /arxiv\.org\//.test(f.url) && (untitled(f) || /^arXiv:/i.test(f.title)) ? parseArxivId(f.url) : null;
      if (arxiv) {
        const paper = await arxivPaper(arxiv).catch(() => null);
        if (paper?.title) return { ...f, title: `${paper.title} (arXiv)` };
      }
      return untitled(f) ? { ...f, title: await pdfTitle(f.url) } : f;
    }),
  );
}

/** A hit whose "title" is only its address ("math.aalto.fi/~kk/files/Hopf-lecture_notes.pdf"). */
export const untitled = (f: { title: string; url: string }) => {
  const t = f.title.trim();
  return !t || t === f.url || (!/\s/.test(t) && /[./]/.test(t)) || f.url.replace(/^https?:\/\//, "").startsWith(t.replace(/^https?:\/\//, ""));
};

/**
 * A title for a linked PDF: what its first page says at the top ("Math 207A: Hopf Algebras"), else
 * its file name made readable; with the site it's on.
 */
export async function pdfTitle(url: string): Promise<string> {
  const u = new URL(url);
  const site = u.hostname.replace(/^www\./, "");
  const file = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.pdf$/i, "");
  const readable = file.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const fallback = readable ? `${readable[0].toUpperCase()}${readable.slice(1)} (${site})` : site;
  if (!/\.pdf($|[?#])/i.test(url)) return fallback;
  const tmp = path.join(os.tmpdir(), `librarian-title-${newId()}.pdf`);
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Librarian)" }, signal: AbortSignal.timeout(12000) });
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!r.ok || bytes.length > 40 * 1024 * 1024) return fallback;
    await writeFile(tmp, bytes);
    const text = await new Promise<string>((resolve) => execFile("pdftotext", ["-q", "-f", "1", "-l", "1", tmp, "-"], { timeout: 8000 }, (_e, out) => resolve(String(out ?? ""))));
    const first = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find((l) => /[a-z]{3}/i.test(l) && l.length >= 6);
    if (first && first.length <= 140) return `${first} (${site})`;
  } catch {
    // Unreachable, slow or not really a PDF: the file name will do.
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return fallback;
}

async function guard(store: CanvasStore, cardId: string, run: () => Promise<void>) {
  const limit = (await loadConfig()).llm.timeoutSeconds;
  try {
    await run();
    // It worked: a later failure gets all its tries again.
    const now = await store.findItem(cardId);
    if (now?.kind === "card" && now.retries && now.stage !== "failed") await store.update(cardId, { retries: 0, retryAt: "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || /aborted due to timeout/.test(message));
    await failCard(
      store,
      cardId,
      timedOut ? `The language model didn't answer within ${limit} seconds. Retry, or raise the timeout in Settings.` : message,
      err instanceof Permanent,
    );
  }
}

// ---- Trying again by itself ----
// A failed card tries again, waiting longer each time (2, 4, 8, 16, 32 s), up to RETRY_TRIES. Its
// retryAt says when, so the canvas can count down, and a restart can pick the timer up again.

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Records a failure, and when tries are left, when the next one is. */
export async function failCard(store: CanvasStore, cardId: string, error: string, permanent = false) {
  const card = await store.findItem(cardId);
  if (card?.kind !== "card") return;
  const tries = card.retries ?? 0;
  if (tries >= RETRY_TRIES || permanent) return void (await store.update(cardId, { stage: "failed", error, retryAt: "" }));
  const ms = retryDelay(tries + 1);
  await store.update(cardId, { stage: "failed", error, retries: tries + 1, retryAt: new Date(Date.now() + ms).toISOString() });
  scheduleRetry(store, cardId, ms);
}

/** Whether the server can start a card over on its own: a box on a slide needs its crop drawn by the page. */
async function restartable(store: CanvasStore, card: CardItem): Promise<boolean> {
  if (card.origin || card.objectKind || card.relates) return true;
  return (await store.findItem(card.parentId))?.kind !== "region";
}

function scheduleRetry(store: CanvasStore, cardId: string, ms: number) {
  const key = `${store.id}/${cardId}`;
  clearTimeout(retryTimers.get(key));
  retryTimers.set(
    key,
    setTimeout(async () => {
      retryTimers.delete(key);
      const card = await store.findItem(cardId);
      if (card?.kind !== "card" || card.hidden || card.stage !== "failed" || !card.retryAt) return;
      if (await restartable(store, card)) await restartCard(store, cardId);
    }, Math.max(0, ms)),
  );
}

/**
 * Starts a card's work over. `manual`: the reader pressed Retry, so it gets all its tries back.
 * Returns false for a box on a slide, which needs its crop from the page (the retry route takes it).
 */
export async function restartCard(store: CanvasStore, cardId: string, manual = false): Promise<boolean> {
  const card = await store.findItem(cardId);
  if (card?.kind !== "card" || !(await restartable(store, card))) return false;
  clearTimeout(retryTimers.get(`${store.id}/${cardId}`));
  // A linked page that already worked is read again fresh; a failed one may retry from what's stored.
  const reread = card.origin?.kind === "page" && card.stage === "done";
  await store.update(cardId, { stage: "reading", error: "", retryAt: "", ...(manual ? { retries: 0 } : {}) });
  if (card.origin?.kind === "page") void readSource(store, cardId, reread);
  else if (card.objectKind) void makeObject(store, cardId);
  else if (card.relates) void explainRelation(store, cardId);
  else void explainSelection(store, cardId);
  return true;
}

/**
 * For a card about a frame of a video: says it's a paused lecture, and what was being said around
 * that moment, which is often what the frame means ("then we glue along the boundary").
 */
async function momentNote(store: CanvasStore, card: CardItem): Promise<string> {
  const img = await sourceImage(store, card);
  if (!img?.moment) return "";
  const video = await store.findItem(img.moment.videoImageId);
  const by = video?.kind === "image" && video.video?.channel ? ` by ${video.video.channel}` : "";
  return [
    `The page is a frame of a video lecture, "${img.moment.title}"${by}, paused at ${clockOf(img.moment.t)} because the reader wanted to understand something in it.`,
    img.transcript
      ? `What the lecturer said around that moment (from the captions, which can mishear technical words; lines marked "(after)" come just after the pause):\n${img.transcript}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function clockOf(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** For a rectangle on an image: `marked` is the whole page with the rectangle drawn, `crop` the region. */
export function explainRegion(store: CanvasStore, cardId: string, images: { marked: string; crop: string }) {
  return guard(store, cardId, async () => {
    const config = await loadConfig();
    const card = (await store.findItem(cardId)) as CardItem;
    const moment = await momentNote(store, card);
    // Words selected on a PDF page come with their exact text: read them, don't guess them from pixels.
    const exact = card.selection ? `\n\nThe part I selected is this text, exactly as the PDF has it (use it as the transcription): "${card.selection}"` : "";
    const content = [
      { type: "text" as const, text: `Here is the page and the part I selected.${moment ? `\n\n${moment}` : ""}${exact}` },
      { type: "image_url" as const, image_url: { url: images.marked } },
      { type: "image_url" as const, image_url: { url: images.crop } },
    ];
    const id = await chatJson<{
      transcription?: string;
      subject?: string;
      topic?: string;
      searchQuery?: string;
      pageText?: string;
      terms?: unknown;
    }>(
      config.llm,
      [
        { role: "system", content: IDENTIFY },
        { role: "user", content },
      ],
    );
    if (card.selection) id.transcription = card.selection;
    const subject = id.subject?.trim() || "this";
    const pageText = str(id.pageText).slice(0, 6000) || undefined;
    const terms = cleanTerms(id.terms);
    // Ask for introductions explicitly; left alone, searches on a slide's words find the paper itself.
    const searchQuery = `${id.searchQuery?.trim() || subject} introduction`;
    await store.update(cardId, { stage: "searching", subject, transcription: id.transcription, topic: id.topic, pageText, terms, searchQuery });
    if (await askFirst(store, cardId)) return;
    await finishRegion(store, cardId);
  });
}

/** Searches and writes a box's explanation from what was read off the page and stored on the card. */
async function finishRegion(store: CanvasStore, cardId: string) {
  let card = (await store.findItem(cardId)) as CardItem;
  const subject = card.subject ?? "this";
  const { pageText, terms = [] } = card;
  await store.update(cardId, { stage: "searching" });
  const sources = await search(card.searchQuery ?? `${subject} introduction`);
  await store.update(cardId, { stage: "writing", sources });
  card = (await store.findItem(cardId)) as CardItem;
  const context = [
    await momentNote(store, card),
    pageText ? `The whole page reads:\n${pageText}` : "",
    terms.length
      ? `Register of the words in the selection (strict terms must be explained as strict terms, informal words for what they point at):\n${terms
          .map((t) => `- "${t.text}": ${t.register}${t.means ? ` (${t.means})` : ""}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  await write(store, card, subject, card.transcription ?? subject, card.topic, [], sources, context);
  void pointAt(store, cardId);
}

// ---- Picking up after a restart ----
// Work in the background (shaping a page, restructuring its sections, pointing at the page,
// growing a piece) is marked "working" while it runs. A restart in the middle used to leave it
// "working" for good, so it never finished or saved. Now each is started again.
onResume((store, items) => {
  // Tries that were due, or waiting, when the server stopped.
  for (const c of items) {
    if (c.kind === "card" && !c.hidden && c.stage === "failed" && c.retryAt) scheduleRetry(store, c.id, Date.parse(c.retryAt) - Date.now());
  }
  for (const c of items) {
    if (c.kind !== "card" || c.hidden || c.stage !== "done") continue;
    // Pages finished before the page store existed go into it, so they're never redone; and
    // sections this one lacks, drawn on another canvas, come from it.
    if (c.origin?.kind === "page") void remember(c).then(() => refillSections(store, c.id), () => {});
    if (c.shaping === "working") void shapePage(store, c.id);
    if (c.sections?.some((sec) => sec.status === "working")) void shapeSections(store, c.id);
    if (c.looking === "working") void pointAt(store, c.id);
    for (const e of c.ext ?? []) if (e.status === "working") void extendPiece(store, c.id, e.id);
  }
});

// ---- Growing the diagram: more, in a chosen shape, from one piece ----

const EXTEND_SHAPES: Record<ExtensionShape, string> = {
  aside: `"aside": 1 to 3 lines off to the side that say more about the piece: what it means, a clarification, the background it assumes. JSON: {"items": [...]}`,
  why: `"why": a chain of 2 to 4 steps of reasoning that leads up to the piece: why it holds ("since … ", "and since … ", "so …"). The last step is what the piece follows from; don't repeat the piece itself. JSON: {"items": [...]}`,
  then: `"then": 2 to 4 steps of what follows from the piece, in order: consequences, or what happens next. JSON: {"items": [...]}`,
  steps: `"steps": 2 to 6 numbered steps of how it is done or how it works, in order, each one plain action or stage. JSON: {"label": "N steps", "items": [...]}`,
  parts: `"parts": the 2 to 5 parts it breaks into, each with a short name and a one-line note, and what they add up to. JSON: {"label": "Has N parts", "parts": [{"name": "...", "note": "..."}], "together": "..."}`,
  split: `"split": exactly 2 branches: two ways, two cases, or two sides of it, each with a 1 to 4 word heading and 1 to 3 lines. JSON: {"label": "Two ways" or "Two cases" or similar, "branches": [{"label": "...", "items": [...]}, {"label": "...", "items": [...]}]}`,
  example: `"example": one concrete example of the piece, worked through plainly in 1 to 3 lines, with real numbers, names or cases. JSON: {"items": [...]}`,
  facts: `"facts": 2 to 5 separate facts about the piece, one line each. JSON: {"items": [...]}`,
};

/** The shape that gives "more of the same" for each part of a diagram. */
const SAME_KIND: Record<string, ExtensionShape> = {
  why: "why",
  what: "aside",
  part: "parts",
  together: "aside",
  here: "then",
  aside: "aside",
};

function sameKind(at: string): ExtensionShape | undefined {
  const section = /^cat-(\w+)$/.exec(at)?.[1];
  if (section) return section === "why" ? "why" : section === "here" ? "then" : section === "parts" ? "parts" : "aside";
  return SAME_KIND[at.split("-")[0]];
}

const EXTEND = `You are a research librarian with unlimited time, helping a curious, intelligent reader who is not a specialist.
An explanation of theirs is drawn as a diagram of short pieces. They pointed at one piece and asked for more right there.
Write only the new pieces, in the shape asked for, growing from that piece. They join the diagram; don't repeat what it already says.
Rules:
- Descend, never climb: use ideas more familiar than the piece; gloss any technical term in plain words.
- Be faithful. Don't invent facts. Where a numbered source supports a claim, cite it as [n].
- Every piece is short: one sentence, at most about 20 words. Plain text. Math as LaTeX between \\( and \\).
Return JSON only, no prose.`;

/** The text of a piece by key: a part of the Sem, a whole section, or a piece of an extension. */
function pieceAt(sem: Sem, ext: Extension[], key: string): string {
  // Extension pieces: x<id>.<n> a line, .p<n> a part, .t what the parts add up to,
  // .b<j> a branch's heading, .b<j>.<n> a line in it.
  const x = /^x([^.]+)\.(?:(\d+)|p(\d+)|(t)|b(\d+)(?:\.(\d+))?)$/.exec(key);
  if (x) {
    const e = ext.find((e) => e.id === x[1]);
    if (!e) return "";
    if (x[2] !== undefined) return e.items?.[Number(x[2])] ?? "";
    if (x[3] !== undefined) {
      const part = e.parts?.[Number(x[3])];
      return part ? `${part.name}: ${part.note}` : "";
    }
    if (x[4]) return e.together ?? "";
    const branch = e.branches?.[Number(x[5])];
    return (x[6] !== undefined ? branch?.items[Number(x[6])] : branch?.label) ?? "";
  }
  const sections: Record<string, string> = {
    "cat-why": `Why it exists:\n${sem.why.join("\n")}`,
    "cat-what": `What it is:\n${[sem.what.gist, ...sem.what.details].join("\n")}`,
    "cat-parts": `Its parts:\n${sem.parts.map((p) => `${p.symbol}: ${p.meaning}`).join("\n")}`,
    "cat-here": `How it's used:\n${sem.here.join("\n")}`,
  };
  if (sections[key]) return sections[key];
  return pieces(sem).find(([k]) => k === key)?.[1] ?? (key === "aside" ? sem.name : "");
}

/** The chain of pieces from the explanation down to `key`, through the extensions it grew from. */
function lineage(sem: Sem, ext: Extension[], key: string): string[] {
  const out: string[] = [];
  let k: string | undefined = key;
  for (let i = 0; k && i < 20; i++) {
    out.unshift(pieceAt(sem, ext, k));
    const x = /^x([^.]+)\./.exec(k);
    k = x ? ext.find((e) => e.id === x[1])?.at : undefined;
  }
  return out.filter(Boolean);
}

const shortStrs = (v: unknown, max: number) => strs(v, max).map((t) => t.slice(0, 400));

/** Writes one extension: the shape the reader picked (or the one their words call for) at a piece. */
export async function extendPiece(store: CanvasStore, cardId: string, extId: string) {
  const card = (await store.findItem(cardId)) as CardItem | undefined;
  const ext = card?.ext?.find((e) => e.id === extId);
  if (!card?.sem || !ext) return;
  const save = (patch: Partial<Extension>) =>
    store.edit(cardId, (now) => (now?.kind === "card" && now.ext ? { ext: now.ext.map((e) => (e.id === extId ? { ...e, ...patch } : e)) } : null));
  try {
    // Pieces of the restructured page can be grown from like any other.
    const all = [...(card.ext ?? []), ...(card.sections ?? []).flatMap((sec) => sec.blocks ?? [])];
    const chain = lineage(card.sem, all, ext.at);
    const sources = card.sources ?? [];
    const told = await readerNotes(store);
    // "Yo I need more", "expand", "keep going": more of the same kind as what they pointed at,
    // decided here rather than left to the model, which reads a vague ask too freely.
    const vague = Boolean(ext.ask && ext.ask.split(/\s+/).length <= 6 && /\b(more|expand|elaborate|continue|keep going|go on|deeper|further|detail)\b/i.test(ext.ask));
    const same = vague ? sameKind(ext.at) : undefined;
    const choosing = Boolean(ext.ask) && !same;
    // Asked for a thing rather than more words ("can you find a youtube video on this?"): it's found
    // (or drawn) on its own card, hung from this piece, and the piece points to it.
    if (choosing) {
      const piece = chain[chain.length - 1] ?? "";
      const { kind, request } = await decideIntent(ext.ask!, `${card.subject ?? ""}: ${ext.focus || piece}`);
      if (kind === "note") {
        // A note isn't a shape: it goes beside the card, about this piece, and the ask is dropped.
        await addNote(store, { text: request, by: "librarian", via: "canvas", on: { id: cardId, key: ext.at, quote: ext.focus || piece }, said: ext.ask });
        await store.edit(cardId, (now) => (now?.kind === "card" && now.ext ? { ext: now.ext.filter((e) => e.id !== extId) } : null));
        return;
      }
      if (kind !== "answer") {
        const made = await findFor(store, card, kind, request, ext.focus || piece);
        await save({ status: "done", made: made.id, items: [request.trim().toLowerCase() === ext.ask!.trim().toLowerCase() ? MADE[kind] : `${MADE[kind]}: ${request}`] });
        return;
      }
    }
    const target: ExtensionShape = same ?? ext.shape;
    const shapes = choosing ? EXTENSION_SHAPES.map((k) => `- ${EXTEND_SHAPES[k]}`).join("\n") : `- ${EXTEND_SHAPES[target]}`;
    const lines = [
      `Subject of the explanation: ${card.subject ?? card.selection ?? ""}`,
      `The whole explanation:\n${semText(card.sem)}`,
      `The piece they pointed at${chain.length > 1 ? " (with the pieces it grew from, top first)" : ""}:\n${chain.join("\n  → ")}`,
      ext.focus ? `They circled these words in it, and want more about them in particular: "${ext.focus}"` : "",
      choosing
        ? `They asked, in their own words: "${ext.ask}"\nChoose the one shape below that best answers that, and write it. Also return "shape": its name.\n${shapes}`
        : `${ext.ask ? `They asked, in their own words: "${ext.ask}", so: more of the same.\n` : ""}The shape they asked for:\n${shapes}`,
      told ? `${told}\nPitch it to that.` : "",
      sources.length ? `Sources found earlier:\n${sources.map((s) => `[${s.n}] ${s.title}: ${s.snippet.slice(0, 300)}`).join("\n")}` : "",
    ].filter(Boolean);
    const raw = await chatJson<Record<string, unknown>>((await loadConfig()).llm, [
      { role: "system", content: EXTEND },
      { role: "user", content: lines.join("\n\n") },
    ]);
    const chosen = str(raw.shape) as ExtensionShape;
    const shape = choosing && EXTENSION_SHAPES.includes(chosen) ? chosen : target;
    const patch: Partial<Extension> = { shape, status: "done", label: str(raw.label).slice(0, 40) || undefined };
    if (shape === "parts") {
      patch.parts = (Array.isArray(raw.parts) ? raw.parts : [])
        .map((p) => p as Record<string, unknown>)
        .map((p) => ({ name: str(p.name ?? p.symbol).slice(0, 120), note: str(p.note ?? p.meaning).slice(0, 300) }))
        .filter((p) => p.name)
        .slice(0, 5);
      patch.together = str(raw.together).slice(0, 400) || undefined;
      if (!patch.parts.length) throw new Error("The answer had no parts");
    } else if (shape === "split") {
      patch.branches = (Array.isArray(raw.branches) ? raw.branches : [])
        .map((b) => b as Record<string, unknown>)
        .map((b) => ({ label: str(b.label).slice(0, 60), items: shortStrs(b.items, 4) }))
        .filter((b) => b.label || b.items.length)
        .slice(0, 2);
      if (patch.branches.length < 2) throw new Error("The answer didn't split into two");
    } else {
      patch.items = shortStrs(raw.items, shape === "steps" ? 6 : 4);
      if (!patch.items.length) throw new Error("The answer had nothing in it");
    }
    await save(patch);
  } catch (err) {
    await save({ status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
  }
}

// ---- Pointing at the page: what each piece refers to, shown beside it ----

const POINT = `The image is a page (a slide, or a page of a paper) that a reader is studying.
Below are the pieces of an explanation about part of it, each with a key.
Some pieces refer to something visible on this page: an equation, a diagram or figure, a particular line, a term, a piece of a formula.
For each piece that clearly does, give the box around that thing on the page.
Boxes are [x0, y0, x1, y1] in thousandths of the image's width and height (0 to 1000), measured from the top-left corner.
Make each box snug, but include all of the thing: the whole equation, the whole diagram.
Leave out pieces that are general background and point at nothing in particular here. Never box the whole page.
Return JSON only, no prose: {"boxes": {"<key>": [x0, y0, x1, y1]}}`;

/** The keys and texts of a Sem's pieces, as SemShapes draws them. */
function pieces(sem: Sem): [string, string][] {
  return [
    ...sem.why.map((t, i): [string, string] => [`why-${i}`, t]),
    ...[sem.what.gist, ...sem.what.details].filter(Boolean).map((t, i): [string, string] => [`what-${i}`, t]),
    ...sem.parts.map((p, i): [string, string] => [`part-${i}`, `${p.symbol}: ${p.meaning}. ${p.note}`]),
    ...(sem.together ? [["together", sem.together] as [string, string]] : []),
    ...sem.here.map((t, i): [string, string] => [`here-${i}`, t]),
  ];
}

/** The image a card's explanation is ultimately about, if it came from a box on one. */
async function sourceImage(store: CanvasStore, card: CardItem): Promise<ImageItem | undefined> {
  let cur: Item | undefined = card;
  for (let i = 0; cur && i < 50; i++) {
    const parent: Item | undefined = await store.findItem(cur.kind === "card" ? cur.parentId : cur.kind === "region" ? cur.imageId : "");
    if (!parent) return undefined;
    if (parent.kind === "image") return parent;
    cur = parent;
  }
  return undefined;
}

/** Converts a model's box to the image's natural pixels, or null if it isn't a usable box. */
function toRect(v: unknown, img: ImageItem): Rect | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  let [x0, y0, x1, y1] = v as number[];
  // Thousandths, as asked; some models answer in pixels or fractions instead.
  const big = Math.max(x0, y0, x1, y1);
  const [sx, sy] = big <= 1.0001 ? [img.naturalW, img.naturalH] : big <= 1000 ? [img.naturalW / 1000, img.naturalH / 1000] : [1, 1];
  [x0, x1] = [Math.min(x0, x1) * sx, Math.max(x0, x1) * sx];
  [y0, y1] = [Math.min(y0, y1) * sy, Math.max(y0, y1) * sy];
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(img.naturalW, x1);
  y1 = Math.min(img.naturalH, y1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < img.naturalW * 0.02 || h < img.naturalH * 0.015) return null;
  if (w * h > img.naturalW * img.naturalH * 0.6) return null; // the whole page points at nothing
  // A little margin, so the thing isn't cut off at its edges.
  const m = Math.round(Math.min(img.naturalW, img.naturalH) * 0.01);
  const rx = Math.max(0, Math.round(x0 - m));
  const ry = Math.max(0, Math.round(y0 - m));
  return { x: rx, y: ry, w: Math.min(img.naturalW - rx, Math.round(w + 2 * m)), h: Math.min(img.naturalH - ry, Math.round(h + 2 * m)) };
}

/** Finds where on the page each piece of a card's explanation points, if it came from an image. */
export async function pointAt(store: CanvasStore, cardId: string) {
  const card = (await store.findItem(cardId)) as CardItem | undefined;
  if (!card?.sem) return;
  const img = await sourceImage(store, card);
  const found = img && assetPath(img.asset);
  if (!img || !found) return;
  await store.update(cardId, { looking: "working", lookImage: img.id });
  try {
    const url = `data:${found.mime};base64,${(await readFile(found.file)).toString("base64")}`;
    const list = pieces(card.sem);
    const r = await chatJson<{ boxes?: Record<string, unknown> }>((await loadConfig()).llm, [
      { role: "system", content: POINT },
      {
        role: "user",
        content: [
          { type: "text", text: `The pieces:\n${list.map(([k, t]) => `${k}: ${t}`).join("\n")}` },
          { type: "image_url", image_url: { url } },
        ],
      },
    ]);
    const keys = new Set(list.map(([k]) => k));
    const looks: Record<string, Rect> = {};
    for (const [k, v] of Object.entries(r.boxes ?? {})) {
      const rough = keys.has(k) ? toRect(v, img) : null;
      // The model finds the right line but drifts along it: snap to the ink actually there.
      if (rough) looks[k] = await snap(found.file, img.naturalW, img.naturalH, rough).catch(() => rough);
    }
    await store.update(cardId, { looks, looking: "done", snapped: true });
  } catch {
    await store.update(cardId, { looking: "failed" });
  }
}

const RESOLVE = `A reader selected some words inside an explanation because they want to know more.
Work out what idea those words refer to IN THAT SENTENCE. Explanations often use everyday stand-ins
("an invisible push", "spread-out flow") for a real concept, and searching the literal words finds
nothing useful. Name the real concept the way an introductory textbook would title it.

That name becomes the subject of an explanation card, which answers about its subject: why it exists,
what it is, its parts, and how it is used here (or how it unfolds). Frame the subject so those questions
make sense of it. An idea or a term needs no framing: just its name. When the words name a particular
person, place, group, organisation, event or work, the reader wants that thing's part in what the
page is about, so the subject is its role there: "Slobodan Milošević's role in the breakup of
Yugoslavia", "Vienna's role in the Congress of Vienna", "the Treaty of Versailles' role in the rise of
fascism". Use the page's own subject, not the selected sentence.

Also judge the REGISTER of the selected words as used in that sentence. Mathematical writing switches
without warning between strict terms of art and casual description, and both look like plain English:
- "term": a technical term with a strict definition (e.g. "energy space", "well-posed", "Coulomb gauge")
- "idiom": a standard insider phrase or move with a precise meaning rarely spelled out (e.g. "closes the bootstrap")
- "casual": everyday words used loosely, often pointing at something precise (e.g. "+ better", "the worst term", "rougher")
- "notation": ONLY a symbol or formula visibly used loosely (in quote marks, with ≈, "morally"), meaning "roughly this"; a precise symbol (L^1(R^2), a defined function) is a "term"
Return JSON only, no prose:
{"concept": "the standard name of the idea, 2-6 words; for a particular person, place, group, event or work, its role in what the page is about, up to 12 words",
 "searchQuery": "2-6 plain words for BEGINNER material (intro notes, textbook chapters, videos) on that concept, without terms specific to the page; for a role, the thing and what it was a role in",
 "register": "term" | "idiom" | "casual" | "notation",
 "means": "for casual words or notation: what is actually meant, precisely, in one sentence; for a term or idiom: a one-line plain gloss",
 "field": "for a term borrowed from another area of mathematics or physics, that area; otherwise empty"}`;

const REGISTER_QUESTION =
  "Judging as a researcher steeped in this field would, using the whole page and the chain of explanations in the state: in the sentence, are the selected words a strict technical term, an insider idiom, casual everyday language, or loosely used notation?";

const REGISTER_CRITERIA: Record<Register, string> = {
  term: "A technical term with a strict, formal definition.",
  idiom: "A standard insider phrase or proof move with a precise meaning that is rarely spelled out.",
  casual: "Everyday words used loosely or descriptively, not a defined term.",
  notation: "A symbol or formula visibly used loosely, such as inside quote marks or with ≈, meaning approximately. A precise symbol is a term.",
};

const isRegister = (v: unknown): v is Register => typeof v === "string" && v in REGISTER_CRITERIA;

/** What the selected words name, as a concept and a beginner search; null if the model can't say. */
async function resolveSelection(
  selection: string,
  sentence: string | undefined,
  context: string,
): Promise<{ concept: string; searchQuery: string; register?: Omit<RegisterNote, "text"> } | null> {
  const config = await loadConfig();
  try {
    const r = await chatJson<{ concept?: string; searchQuery?: string; register?: string; means?: string; field?: string }>(config.llm, [
      { role: "system", content: RESOLVE },
      {
        role: "user",
        content: [
          `Selected words: ${selection}`,
          sentence ? `The sentence they are in: ${sentence}` : "",
          context ? `Everything known about where that sentence comes from:\n${context}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ]);
    const concept = str(r.concept);
    const searchQuery = str(r.searchQuery);
    if (!concept || !searchQuery) return null;
    let register = isRegister(r.register) ? r.register : undefined;

    // Register is a typed choice, which is what the fast decision model is for. Its answer wins
    // when it is confident; the LLM's judgement is the fallback.
    if (systemOneConfigured(config.systemOne)) {
      try {
        const d = await decideChoice(
          config.systemOne,
          { selected: selection, sentence: sentence ?? "", context },
          REGISTER_QUESTION,
          REGISTER_CRITERIA,
        );
        if (isRegister(d.choice) && d.confidence >= 0.6) register = d.choice;
      } catch {
        // Advisory: keep the LLM's answer.
      }
    }
    return {
      concept,
      searchQuery,
      register: register ? { register, means: str(r.means), field: str(r.field) || undefined } : undefined,
    };
  } catch {
    return null;
  }
}

const REGISTER_GUIDANCE: Record<Register, string> = {
  term:
    "The selected words are a TERM OF ART with a strict definition. Give that actual definition, reached by descending from familiar ideas, and don't blur it into a loose analogy.",
  idiom:
    "The selected words are an INSIDER IDIOM. Say what the standard move or phrase means precisely, and why insiders say it this way.",
  casual:
    "The selected words are INFORMAL: the author is speaking loosely. Explain what they are pointing at, precisely, and make clear the words themselves aren't a defined term.",
  notation:
    "The selected notation is used LOOSELY (for example in quote marks). Explain the rough statement and what the exact one would add.",
};

/** For words the learner selected inside another card: explain them one level further down. */
export function explainSelection(store: CanvasStore, cardId: string) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    const selection = card.selection ?? "";
    const { path, topic } = await ancestry(store, card);
    const context = await trail(store, card);

    // First work out what the words mean where they were selected: the literal words of a plain
    // gloss ("invisible push") find nothing, while the page topic pulls the search back toward the
    // specialist material. Search for the concept itself, at beginner level.
    await store.update(cardId, { stage: "reading" });
    const resolved = await resolveSelection(selection, card.context, context);
    const subject = resolved?.concept ?? selection;
    const quoted = card.context ? `“${selection}” in: ${card.context}` : selection;
    const register: RegisterNote | undefined = resolved?.register ? { text: selection, ...resolved.register } : undefined;
    const searchQuery = resolved ? `${resolved.searchQuery} introduction` : `${selection} explained introduction`;
    await store.update(cardId, { stage: "searching", subject, topic, transcription: card.context ? quoted : undefined, register, searchQuery });
    if (await askFirst(store, cardId)) return;
    await finishSelection(store, cardId);
  });
}

/** Searches and writes the explanation of selected words, from what is stored on the card. */
async function finishSelection(store: CanvasStore, cardId: string) {
  const card = (await store.findItem(cardId)) as CardItem;
  const selection = card.selection ?? "";
  const { path, topic } = await ancestry(store, card);
  const context = [await momentNote(store, card), await trail(store, card)].filter(Boolean).join("\n\n");
  const quoted = card.context ? `“${selection}” in: ${card.context}` : selection;
  const register = card.register;
  await store.update(cardId, { stage: "searching" });
  const sources = await search(card.searchQuery ?? `${selection} explained introduction`);
  await store.update(cardId, { stage: "writing", sources });
  const guidance = register ? `${REGISTER_GUIDANCE[register.register]}${register.means ? ` (${register.means})` : ""}` : "";
  // Explaining a question someone typed (a note at the root), not words picked from a page or card.
  const parent = await store.findItem(card.parentId);
  const flow = parent?.kind === "card" && parent.origin?.kind === "note" && !parent.parentId;
  await write(store, card, card.subject ?? selection, quoted, topic, path, sources, [context, guidance].filter(Boolean).join("\n\n"), flow);
  void pointAt(store, cardId);
}

// ---- Clarifying questions: about the reader's goal and context, before explaining ----

const CLARIFY = `You are a research librarian about to explain something to a curious reader who is not a specialist.
Before explaining, decide whether ONE short question to the reader would change the explanation a lot.
Good reasons to ask:
- You don't know WHY they are reading this (following a talk, a course, their own research, curiosity) and it changes where to start or how deep to go.
- You don't know what they already know (say, calculus but not linear algebra) and the explanation hinges on it.
- What they asked could mean two quite different things.
If they haven't told you anything about themselves yet, a question about their goal or background is usually worth asking:
it decides where the explanation starts. Once you know those, ask again only when what they asked is genuinely ambiguous.
Do NOT ask when they have already told you (see below), when the page or their words make it clear, or when the explanation
would come out about the same either way. Never ask about something you could look up.
Return JSON only, no prose:
{"ask": true or false,
 "question": "if asking: one short, friendly question in plain words",
 "options": ["if asking: 2 to 4 likely answers, a few words each, that the reader can click"]}`;

/** What the reader has said about their goal and background on this canvas, for a prompt. */
async function readerNotes(store: CanvasStore): Promise<string> {
  const notes = (await getCanvasInfo(store.id))?.reader ?? [];
  if (!notes.length) return "";
  return `What the reader has told you about themselves and their goal:\n${notes
    .map((n) => `- Asked "${n.q}": ${n.a || "they preferred not to say; just explain"}`)
    .join("\n")}`;
}

/** Asks the reader a question first when the model judges it would change the answer; true if it asked. */
async function askFirst(store: CanvasStore, cardId: string): Promise<boolean> {
  const card = (await store.findItem(cardId)) as CardItem;
  if (card.clarify) return false; // asked already: answered, skipped, or being retried
  const notes = (await getCanvasInfo(store.id))?.reader ?? [];
  if (notes.length >= 4) return false; // enough is known; stop asking
  const { path, root } = await ancestry(store, card);
  const lines = [
    `Subject: ${card.subject ?? card.selection ?? "?"}`,
    `What the reader selected or asked: ${card.transcription ?? card.selection ?? ""}`,
    card.topic ? `The page is about: ${card.topic}` : "",
    path.length ? `They got here by asking about: ${path.join(" → ")}` : "",
    (card.pageText ?? root?.pageText) ? `The page begins:\n${(card.pageText ?? root?.pageText ?? "").slice(0, 1500)}` : "",
    (await readerNotes(store)) || "They haven't told you anything about themselves or their goal yet.",
  ].filter(Boolean);
  try {
    const r = await chatJson<{ ask?: unknown; question?: unknown; options?: unknown }>((await loadConfig()).llm, [
      { role: "system", content: CLARIFY },
      { role: "user", content: lines.join("\n\n") },
    ]);
    const question = str(r.question).slice(0, 300);
    if (r.ask !== true || !question) return false;
    const options = strs(r.options, 4).map((o) => o.slice(0, 80));
    await store.update(cardId, { stage: "asking", clarify: { question, options } });
    return true;
  } catch {
    return false; // asking is optional; explain without it
  }
}

/** Carries on explaining once the reader has answered (or skipped) the question. */
export function continueAfterAnswer(store: CanvasStore, cardId: string) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    const parent = await store.findItem(card.parentId);
    await (parent?.kind === "region" ? finishRegion(store, cardId) : finishSelection(store, cardId));
  });
}

// ---- Relations: the learner asks how two things are related ----

const RELATE = `A reader dragged a connection between two things they are studying and asked how they are related.
They are not claiming they ARE related; they want to find out.
Return JSON only, no prose:
{"relation": "a short name for how they relate, 3-8 words, or 'only loosely related' if that's the truth",
 "searchQuery": "2-6 plain words for BEGINNER material on the relationship between the two ideas, without terms specific to the page"}`;

const RELATION_GUIDANCE = `The reader asked how the two things below are related; they are not claiming they are. Explain the ACTUAL relationship:
- "why": the chain that links the first to the second, step by step.
- "what": the relationship in one sentence (gist). If they are only loosely related or not related at all, say so plainly here.
- "parts": exactly two entries, the first thing then the second; "symbol" is its name, "meaning" its role in the relationship.
- "together": the connecting idea that joins them.
- "here": where on this page the link matters, if it does.`;

/** One side of a relation, with everything known about where it came from. */
const READ_PAGE = `Read this whole page for a reader who will study it.
Return JSON only, no prose:
{"pageText": "all of the page's text in reading order, with math as LaTeX", "topic": "what the page is about, a few words"}`;

/**
 * A whole image's text, read by the vision model the first time anything needs it and kept on the
 * image, so each page is read once however many relations and questions use it.
 */
async function readPage(store: CanvasStore, imageId: string): Promise<{ pageText: string; topic: string }> {
  const img = await store.findItem(imageId);
  if (img?.kind !== "image") return { pageText: "", topic: "" };
  if (img.pageText) return { pageText: img.pageText, topic: img.topic ?? "" };
  const found = assetPath(img.asset);
  if (!found) return { pageText: "", topic: "" };
  const url = `data:${found.mime};base64,${(await readFile(found.file)).toString("base64")}`;
  const config = await loadConfig();
  const r = await chatJson<{ pageText?: string; topic?: string }>(config.llm, [
    { role: "system", content: READ_PAGE },
    { role: "user", content: [{ type: "text", text: "Here is the page." }, { type: "image_url", image_url: { url } }] },
  ]);
  const pageText = str(r.pageText).slice(0, 8000);
  const topic = str(r.topic);
  if (pageText) await store.update(imageId, { pageText, topic });
  return { pageText, topic };
}

async function describe(store: CanvasStore, id: string): Promise<{ name: string; text: string }> {
  const item = await store.findItem(id);
  if (item?.kind === "image") {
    // A whole slide: read it (once) and describe it by what it says.
    const { pageText, topic } = await readPage(store, id);
    const name = topic || item.name;
    return { name, text: [`The whole page "${name}" (${item.name}) reads:`, pageText].filter(Boolean).join("\n") };
  }
  if (item?.kind !== "card") return { name: "?", text: "" };
  const name = item.subject ?? item.selection ?? "this";
  const lines = [
    `"${name}"`,
    item.transcription ? `Selected text: ${item.transcription}` : "",
    item.pageText ? `The page it came from reads:\n${item.pageText}` : "",
    await trail(store, item),
    `Its explanation:\n${cardText(item)}`,
  ];
  return { name, text: lines.filter(Boolean).join("\n") };
}

export function explainRelation(store: CanvasStore, cardId: string) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    const [aId, bId] = card.relates!;
    await store.update(cardId, { stage: "reading" });
    // One at a time: reading a whole slide is a vision call, and two at once can starve a local model.
    const a = await describe(store, aId);
    const b = await describe(store, bId);
    const config = await loadConfig();
    const both = `FIRST: ${a.text}\n\nSECOND: ${b.text}`;

    let relation = `${a.name} and ${b.name}`;
    let query = `${a.name} ${b.name} relationship`;
    try {
      const r = await chatJson<{ relation?: string; searchQuery?: string }>(config.llm, [
        { role: "system", content: RELATE },
        { role: "user", content: both },
      ]);
      relation = str(r.relation) || relation;
      query = str(r.searchQuery) || query;
    } catch {
      // Fall back to searching the two names together.
    }
    const subject = relation;
    await store.update(cardId, { stage: "searching", subject });
    const sources = await search(`${query} introduction`);
    await store.update(cardId, { stage: "writing", sources });
    await write(store, card, subject, `How are "${a.name}" and "${b.name}" related?`, undefined, [], sources, `${RELATION_GUIDANCE}\n\n${both}`);
  });
}

// ---- Conversation held at a card ----

const CHAT = `You are a research librarian with unlimited time, talking with a curious, intelligent reader who is not a specialist.
The conversation is about ONE card on their canvas; everything known about it follows.
Rules:
- Descend, never climb: answer with ideas more familiar than what is asked about, and gloss any technical term you must use in plain words.
- Say plainly when a word is a strict technical term and when it is being used loosely.
- Be faithful. Where one of the card's numbered sources supports a claim, cite it as [n]. If you don't know, say so.
- Be brief: 1 to 4 sentences unless the reader asks for more. Plain text, math as plain text.`;

/** Answers the learner's latest message in a card's conversation, with everything known about the card. */
export async function chatAbout(store: CanvasStore, cardId: string) {
  const config = await loadConfig();
  const card = (await store.findItem(cardId)) as CardItem;
  try {
    const about = await describe(store, cardId);
    const sources = (card.sources ?? []).map((s) => `[${s.n}] ${s.title} (${s.url})\n${s.snippet}`).join("\n\n");
    const history: Message[] = (card.chat ?? []).slice(-20).map((m) => ({ role: m.role, content: m.text }));
    const reply = await chat(config.llm, [
      { role: "system", content: `${CHAT}\n\nThe card:\n${about.text}${sources ? `\n\nIts sources:\n${sources}` : ""}` },
      ...history,
    ]);
    await store.record({ type: "chat", id: cardId, message: { role: "assistant", text: reply.trim(), at: new Date().toISOString() } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || /aborted due to timeout/.test(message));
    const text = timedOut
      ? `(No answer within ${config.llm.timeoutSeconds} seconds. Ask again, or raise the timeout in Settings.)`
      : `(Couldn't answer: ${message})`;
    await store.record({ type: "chat", id: cardId, message: { role: "assistant", text, at: new Date().toISOString() } });
  } finally {
    await store.update(cardId, { chatPending: false });
  }
}

// ---- Things a conversation can make ----
// Asking for videos, reading or a diagram makes an object on its own card, connected to the card
// it was asked from, so a card gathers a collection instead of a long transcript.

type Intent = "answer" | "note" | ObjectKind;

const INTENT_CRITERIA: Record<Intent, string> = {
  answer: "A question to be answered in words.",
  note: "A request to note, jot down or remember something for later, rather than to answer it now.",
  videos: "A request for videos, lectures or talks to watch.",
  links: "A request for reading: articles, notes, papers, textbooks or other pages.",
  diagram: "A request to draw, sketch, picture or diagram something.",
  papers: "A request for research papers, preprints or arXiv articles.",
  notebook: "A request for code, a worked example to run, or a Jupyter notebook.",
  table: "A request for data, figures, statistics or numbers, as a table or to compare.",
  plot: "A request to plot or graph a function, equation or curve, or data points, on axes.",
  graph: "A request for a network of nodes and edges: a graph in graph theory, a tree, a map of how things connect.",
  map: "A request for a geographic map: where places are, a route, countries or regions.",
  set: "A request for a collection to look through: the top, main or notable people, groups, works or things of something, as a list.",
};
const isIntent = (v: unknown): v is Intent => typeof v === "string" && v in INTENT_CRITERIA;

const INTENT = `A reader typed a message in the conversation box on a card about a topic they are studying.
Decide what they want: an answer in words, or an object made for them.
Return JSON only: {"kind": "answer" | "note" | "set" | "videos" | "links" | "diagram" | "papers" | "notebook" | "table" | "plot" | "graph" | "map", "request": "what they asked for, restated in a few words"}
- "videos": they ask for videos, lectures or talks to watch.
- "links": they ask for things to read: articles, notes, papers, textbook chapters.
- "diagram": they ask you to draw, sketch, picture or diagram something.
- "papers": they ask for research papers, preprints, or arXiv.
- "notebook": they ask for code, an example to run or play with, or a Jupyter notebook.
- "table": they ask for data, figures, statistics, numbers over time, or a comparison in numbers.
- "plot": they ask to plot or graph a function, an equation, a curve, or data on x and y axes.
- "graph": they ask for nodes and edges: a graph in graph theory, a tree, a network, a map of how things connect.
- "map": they ask for a geographic map, or where places are on the earth: cities, battles, routes, countries.
- "set": they ask for a collection to look through: the top, main, best-known or notable people, bands, works, books,
  places or things of a subject ("who were the big names", "list the key albums", "show me some of them").
  ("graph y = x^2" is a plot; "draw K4" or "how are these ideas connected" is a graph; a picture or sketch is a diagram.)
- "note": they ask you to note, jot down or remember something for later ("note that…", "remind me to check this",
  "remember: the 1 is the unit"). "request" is then the note itself, as it should read (their point, in their words).
- "answer": anything else.`;

async function decideIntent(text: string, about: string): Promise<{ kind: Intent; request: string }> {
  const config = await loadConfig();
  let kind: Intent = "answer";
  let request = text;
  try {
    const r = await chatJson<{ kind?: string; request?: string }>(config.llm, [
      { role: "system", content: INTENT },
      { role: "user", content: `The card is about: ${about}\n\nTheir message: ${text}` },
    ]);
    if (isIntent(r.kind)) kind = r.kind;
    request = str(r.request) || text;
  } catch {
    // Default to answering.
  }
  // What a message asks for is a typed choice, which is the fast decision model's job.
  if (systemOneConfigured(config.systemOne)) {
    try {
      const d = await decideChoice(config.systemOne, { message: text, card: about }, "What does this message ask for?", INTENT_CRITERIA);
      if (isIntent(d.choice) && d.confidence >= 0.6) kind = d.choice;
    } catch {
      // Keep the LLM's call.
    }
  }
  return { kind, request };
}

/** A card's likely height before it has ever been measured: object cards vary by what they hold. */
function expectedHeight(c: CardItem): number {
  if (c.objectKind === "videos") return 1150;
  if (c.objectKind === "set") return 1300;
  if (c.objectKind === "diagram") return 1100;
  if (c.objectKind === "links") return 900;
  if (c.objectKind === "table" || c.objectKind === "plot" || c.objectKind === "graph" || c.objectKind === "map") return 800;
  return 1000;
}

/** Where a new object goes: beside the card it came from, below anything already there. */
async function placeBeside(store: CanvasStore, from: CardItem): Promise<{ x: number; y: number }> {
  const { items } = await store.getState();
  const x = from.x + from.w + 64;
  let y = from.y;
  const column = items.filter(
    (i): i is CardItem => i.kind === "card" && !i.hidden && i.x < x + CARD_WIDTH && x < i.x + i.w,
  );
  let moved = true;
  while (moved) {
    moved = false;
    for (const c of column) {
      const bottom = c.y + (c.h ?? expectedHeight(c));
      if (y < bottom + 24 && y + 1100 > c.y - 24) {
        y = bottom + 24;
        moved = true;
      }
    }
  }
  return { x, y };
}

const QUERY = `Write a short web search query, 2-6 plain words, for material on what the reader asked for, given the card it was asked about.
Beginner material, unless they ask for something else (academic, from universities, advanced, by historians…): then put
that in the query ("university lecture", "historian", "seminar").
Never use terms specific to the page or paper. Return JSON only: {"searchQuery": "..."}`;

async function queryFor(request: string, about: string, fallback: string): Promise<string> {
  const config = await loadConfig();
  try {
    const r = await chatJson<{ searchQuery?: string }>(config.llm, [
      { role: "system", content: QUERY },
      { role: "user", content: `The card is about: ${about}\n\nThey asked for: ${request}` },
    ]);
    return str(r.searchQuery) || fallback;
  } catch {
    return fallback;
  }
}

/** Each video's channel, from YouTube's oEmbed (no key needed); left out where it can't be had. */
async function withChannels(videos: Video[]): Promise<Video[]> {
  return Promise.all(
    videos.map(async (v) => {
      try {
        const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(v.url)}`, { signal: AbortSignal.timeout(5000) });
        const j = r.ok ? ((await r.json()) as { author_name?: string; title?: string }) : {};
        return { ...v, ...(j.author_name ? { channel: j.author_name } : {}), ...(j.title ? { title: j.title } : {}) };
      } catch {
        return v;
      }
    }),
  );
}

const JUDGE_VIDEOS = `You pick videos for a reader, from search results. Each has a title, the channel that posted it, and a snippet.
Judge each against what the reader asked for, using the channel as much as the title:
- If they asked for academic, scholarly or university material: prefer universities, museums, research institutes,
  named professors and historians, conference or seminar talks; leave out general entertainment and explainer channels.
- Otherwise prefer clear explanations of the subject from reliable channels.
- Always leave out videos that aren't about the subject, reaction videos, and clips with no substance.
Return JSON only: {"pick": [indices of the videos to show, best first, at most 6]}. An empty list if none fit.`;

/** The videos that fit the request, best first (as found, if the judging fails). */
async function judgeVideos(videos: Video[], request: string, subject: string): Promise<Video[]> {
  if (videos.length <= 1) return videos;
  try {
    const list = videos.map((v, i) => `[${i}] ${v.title} | channel: ${v.channel ?? "unknown"} | ${v.snippet.slice(0, 160)}`).join("\n");
    const r = await chatJson<{ pick?: unknown }>((await loadConfig()).llm, [
      { role: "system", content: JUDGE_VIDEOS },
      { role: "user", content: `Subject: ${subject}\nThey asked for: ${request}\n\nResults:\n${list}` },
    ]);
    const picked = (Array.isArray(r.pick) ? r.pick : []).map(Number).filter((i, k, a) => Number.isInteger(i) && videos[i] && a.indexOf(i) === k);
    if (!picked.length) throw new Error("None of the videos found fit. Try asking differently.");
    return picked.map((i) => videos[i]);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("None of")) throw e;
    return videos;
  }
}

const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

const DIAGRAM = `You draw clear explanatory diagrams for a curious reader who is not a specialist.
Draw ONE SVG diagram for what they asked, in the context of the card.
Rules:
- Descend: use familiar ideas, label things in plain words, and gloss any technical term.
- viewBox="0 0 480 H" with H at most 640. Only rect, circle, ellipse, line, polyline, polygon, path, text, tspan, g, defs, marker.
- Readable: font-family sans-serif, font-size 12 to 16, dark strokes on a white or light background, arrows with markers, no overlapping labels.
- No scripts, no images, no external links.
- Draw in reading order (background and main shapes first, then arrows, then labels), since the reader watches it appear as you write.
Reply with ONLY the SVG, from <svg to </svg>, no code fences. Its first children are <title> (what it shows, a few words) and <desc> (one or two sentences on how to read it).`;

/** Makes the object an object card asks for. */
export function makeObject(store: CanvasStore, cardId: string) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    const from = await store.findItem(card.parentId);
    const whole = from?.kind === "card" ? await describe(store, from.id) : { name: "this", text: "" };
    // Asked for about particular words of that card: those words are the subject.
    const about = card.selection ? { ...whole, text: `${whole.text}\n\nSpecifically this part of it: "${card.selection}"` } : whole;
    const request = card.request ?? "";
    const config = await loadConfig();
    const enabled = SEARCHER_IDS.filter((id) => config.searchers[id].enabled);

    if (card.objectKind === "notebook") {
      const nb = await exampleNotebook(request, about.text, (stage) => void store.update(cardId, { stage }));
      await store.update(cardId, {
        stage: "done",
        subject: `Notebook: ${nb.title}`,
        object: { type: "notebook", title: nb.title, language: nb.language, cells: nb.cells, ...(nb.source ? { source: nb.source } : {}), ...(nb.why ? { why: nb.why } : {}) },
      });
    } else if (card.objectKind === "videos") {
      await store.update(cardId, { stage: "searching" });
      const q = await queryFor(request, about.text, `${about.name} explained`);
      const results = enabled.length ? await runSearch(config, `${q} lecture`, enabled, 10, "youtube.com") : {};
      const seen = new Set<string>();
      const videos: Video[] = [];
      for (const r of Object.values(results)) {
        for (const h of r?.ok ? r.hits : []) {
          const id = h.url.match(YOUTUBE_ID)?.[1];
          if (!id || seen.has(id)) continue;
          seen.add(id);
          videos.push({ url: `https://www.youtube.com/watch?v=${id}`, videoId: id, title: h.title.replace(/\s*-\s*YouTube\s*$/i, ""), snippet: h.snippet.slice(0, 200) });
        }
      }
      if (!videos.length) throw new Error(`No videos found for "${q}". Try asking differently, or enable another searcher.`);
      // Who posted each one, then a second look at which really fit what was asked (a university's
      // lecture, not a hobby channel's, when that's what they want).
      await store.update(cardId, { stage: "writing" });
      const judged = await judgeVideos(await withChannels(videos.slice(0, 15)), request, about.name);
      await store.update(cardId, { stage: "done", subject: `Videos: ${request}`, object: { type: "videos", videos: judged.slice(0, 6) } });
    } else if (card.objectKind === "set") {
      await store.update(cardId, { stage: "writing" });
      const set = await makeSet(request, about.text.slice(0, 1500));
      await store.update(cardId, { stage: "done", subject: set.title, object: { type: "set", ...set } });
    } else if (card.objectKind === "links") {
      await store.update(cardId, { stage: "searching" });
      const q = await queryFor(request, about.text, `${about.name} introduction`);
      const links = await search(`${q} introduction`);
      if (!links.length) throw new Error(`Nothing found for "${q}".`);
      await store.update(cardId, { stage: "done", subject: `Reading: ${request}`, object: { type: "links", links } });
    } else if (card.objectKind === "papers") {
      // Papers are the authority, not the onramp: here precise technical keywords are what work.
      await store.update(cardId, { stage: "searching" });
      let q = about.name;
      try {
        const r = await chatJson<{ query?: string }>(config.llm, [
          { role: "system", content: PAPER_QUERY },
          { role: "user", content: `The card is about: ${about.text}\n\nThey asked for: ${request}` },
        ]);
        q = str(r.query) || q;
      } catch {}
      const found = (await searchArxiv(q, { max: 8 })).papers;
      // arXiv falls back to any word matching, which for a topic it barely covers (history, law,
      // most humanities) brings back nonsense: only papers actually about it are kept.
      const papers = await onTopic(found, `${request} (${about.name})`);
      if (papers.length) {
        await store.update(cardId, { stage: "done", subject: `Papers: ${request}`, object: { type: "papers", papers } });
      } else {
        // arXiv is physics, maths and computing; for anything else, scholarly reading from the web.
        await store.update(cardId, { stage: "searching" });
        const links = await search(`${request} scholarly article journal pdf`);
        if (!links.length) throw new Permanent(`arXiv has no papers on this, and the web search found no scholarly reading either.`);
        await store.update(cardId, {
          stage: "done",
          subject: `Papers: ${request} (arXiv had none on this; scholarly reading from the web instead)`,
          object: { type: "links", links },
        });
      }
    } else if (card.objectKind === "diagram") {
      await store.update(cardId, { stage: "writing" });
      // Draw it as it streams: each frame is the SVG so far, closed and cleaned, shown to viewers
      // but not logged. Only the finished diagram is recorded.
      let lastFrame = 0;
      let drawn = "";
      try {
        drawn = await chatStream(
          diagramEndpoint(config),
          [
            { role: "system", content: DIAGRAM },
            { role: "user", content: `They asked for: ${request}\n\nThe card it is about:\n${about.text}` },
          ],
          (soFar) => {
            const now = Date.now();
            if (now - lastFrame < 300) return;
            lastFrame = now;
            const frame = partialSvg(soFar);
            if (frame) store.setLive(cardId, { object: { type: "diagram", svg: frame, caption: "" } });
          },
        );
      } finally {
        store.clearLive(cardId);
      }
      const svg = sanitizeSvg(drawn);
      if (!svg) throw new Error("The model's drawing wasn't a usable SVG. Try again.");
      const { title, caption } = svgLabels(svg);
      await store.update(cardId, { stage: "done", subject: title || `Diagram: ${request}`, object: { type: "diagram", svg, caption } });
    } else if (card.objectKind === "table") {
      // Figures come off real pages, credited; the previous table, when it's being redone, to change.
      await store.update(cardId, { stage: "searching" });
      const q = await queryFor(request, about.text, `${about.name} statistics`);
      const found = await search(`${q} data`);
      await store.update(cardId, { stage: "writing" });
      const before = card.replaced?.object.type === "table" ? card.replaced.object : undefined;
      const table = await makeTable(request, about.text, found, before);
      await store.update(cardId, { stage: "done", subject: table.title, object: { type: "table", ...table } });
    } else if (card.objectKind === "plot") {
      await store.update(cardId, { stage: "writing" });
      const before = card.replaced?.object.type === "plot" ? { title: card.replaced.object.title, plot: card.replaced.object.plot } : undefined;
      const p = await makePlot(request, about.text, before);
      await store.update(cardId, { stage: "done", subject: p.title, object: { type: "plot", ...p } });
    } else if (card.objectKind === "graph") {
      await store.update(cardId, { stage: "writing" });
      const before = card.replaced?.object.type === "graph" ? card.replaced.object : undefined;
      const g = await makeGraph(request, about.text, before);
      await store.update(cardId, { stage: "done", subject: g.title, object: { type: "graph", ...g } });
    } else if (card.objectKind === "map") {
      await store.update(cardId, { stage: "writing" });
      const before = card.replaced?.object.type === "map" ? card.replaced.object : undefined;
      const m = await makeMap(request, about.text, before, (stage) => void store.update(cardId, { stage }));
      await store.update(cardId, { stage: "done", subject: m.title, object: { type: "map", ...m } });
    }
  });
}

const MADE: Record<ObjectKind, string> = {
  set: "Putting together a set",
  videos: "Finding videos",
  links: "Finding reading",
  diagram: "Drawing a diagram",
  papers: "Searching arXiv",
  notebook: "Finding an example notebook",
  table: "Gathering the figures",
  plot: "Plotting",
  graph: "Drawing the graph",
  map: "Making a map",
};

const REDOING: Record<ObjectKind, string> = {
  set: "Putting together another set",
  videos: "Finding other videos",
  links: "Finding other reading",
  diagram: "Drawing it again",
  papers: "Searching arXiv again",
  notebook: "Finding another notebook",
  table: "Gathering the figures again",
  plot: "Plotting it again",
  graph: "Drawing the graph again",
  map: "Making the map again",
};

const REFINE = `A card on a reader's study canvas holds something found or made for them: videos, reading, research
papers, a diagram, a notebook, a table of data, a plot, a graph or a map. They wrote a message on that card.
Decide whether the message asks to change what the card holds: different, better, more academic, shorter, newer,
in another language, from other sources, drawn differently, on another scale or range, with something added or taken out, and so on. A question about the content itself
("what does the second video cover?", "why is this arrow here?") is NOT a change.
If it asks for a change, rewrite what to find or make, as one request that keeps the original subject and adds
what they now want.
Return JSON only: {"change": true | false, "request": "the new request, a short phrase"}`;

/** The card's request, rewritten by a message asking for something other than what it holds; or null. */
async function refineRequest(card: CardItem, message: string): Promise<string | null> {
  try {
    const r = await chatJson<{ change?: boolean; request?: string }>((await loadConfig()).llm, [
      { role: "system", content: REFINE },
      { role: "user", content: `The card holds ${card.objectKind}, found for: ${card.request ?? card.subject ?? ""}\n${card.selection ? `About these words: "${card.selection}"\n` : ""}\nTheir message: ${message}` },
    ]);
    const request = str(r.request).trim();
    return r.change === true && request ? request.slice(0, 200) : null;
  } catch {
    return null;
  }
}

const ON_TOPIC =
  "Is this research paper genuinely about the topic the reader asked for? Sharing a word (\"federal\", a place name, a common term) is not enough: it must actually study that topic.";

/**
 * Keeps the papers that are really about `topic`. A yes or no per paper is the decision model's
 * call, when there is one; otherwise the language model judges them all at once.
 */
export async function onTopic(papers: Paper[], topic: string): Promise<Paper[]> {
  if (!papers.length) return papers;
  const config = await loadConfig();
  if (systemOneConfigured(config.systemOne)) {
    try {
      const yes = await Promise.all(
        papers.map((p) => decideYesNo(config.systemOne, { topic, title: p.title, category: p.category, abstract: p.summary.replace(/\s+/g, " ").slice(0, 800) }, ON_TOPIC)),
      );
      return papers.filter((_, i) => yes[i] >= 0.5);
    } catch {
      // Fall through to the language model.
    }
  }
  try {
    const r = await chatJson<{ keep?: unknown }>((await loadConfig()).llm, [
      {
        role: "system",
        content: `A reader asked for research papers on a topic. Here are search results. Keep only those genuinely about the topic (a paper that merely shares a word, like "federal" or a place name, is not). Return JSON only: {"keep": [numbers of the papers to keep]} ([] when none are).`,
      },
      { role: "user", content: `Topic: ${topic}\n\n${papers.map((p, i) => `${i + 1}. ${p.title} (${p.category})\n${p.summary.replace(/\s+/g, " ").slice(0, 300)}`).join("\n\n")}` },
    ]);
    if (!Array.isArray(r.keep)) return papers;
    const keep = new Set(r.keep.map(Number));
    return papers.filter((_, i) => keep.has(i + 1));
  } catch {
    // Can't judge: show what was found rather than nothing.
    return papers;
  }
}

/** A failure trying again won't fix (nothing exists to find): the card says so and doesn't retry by itself. */
export class Permanent extends Error {}

const PAPER_QUERY = `Write an arXiv search for research papers on what the reader asked for, given the card it was asked about.
Use 2-5 precise technical keywords that would appear in paper titles or abstracts (names of equations, objects, methods).
Return JSON only: {"query": "..."}`;

/** Handles the latest message in a card's conversation: answers it, or makes what it asks for. */
export async function handleChat(store: CanvasStore, cardId: string) {
  const card = (await store.findItem(cardId)) as CardItem;
  const last = [...(card.chat ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return store.update(cardId, { chatPending: false });
  // On a card that holds something found (videos, reading, papers, a diagram, a notebook), a message
  // about what's there ("more academic ones, by universities") redoes it in place, not beside it.
  if (card.objectKind && card.stage === "done") {
    const redo = await refineRequest(card, last.text);
    if (redo) {
      await store.record({ type: "chat", id: cardId, message: { role: "assistant", text: `${REDOING[card.objectKind]}: ${redo}`, at: new Date().toISOString() } });
      await store.update(cardId, { chatPending: false, request: redo, object: undefined, stage: "reading", ...(card.object ? { replaced: { object: card.object, request: card.request, subject: card.subject } } : {}) });
      await makeObject(store, cardId);
      return;
    }
  }
  const { kind, request } = await decideIntent(last.text, card.subject ?? card.selection ?? "this");
  if (kind === "answer") return chatAbout(store, cardId);
  if (kind === "note") {
    const note = await addNote(store, { text: request, by: "librarian", via: "chat", on: { id: cardId }, said: last.text });
    await store.record({ type: "chat", id: cardId, message: { role: "assistant", text: `Noted beside the card: ${request}`, at: new Date().toISOString(), ...(note ? { objectId: note.id } : {}) } });
    await store.update(cardId, { chatPending: false });
    return;
  }

  const object = await addObject(store, card, kind, request);
  await store.record({
    type: "chat",
    id: cardId,
    message: { role: "assistant", text: `${MADE[kind]}: ${request}`, at: new Date().toISOString(), objectId: object.id },
  });
  await store.update(cardId, { chatPending: false });
  await makeObject(store, object.id);
}

/** Puts a card that will hold videos, reading, papers or a diagram beside `from`; returns it at once. */
async function addObject(store: CanvasStore, from: CardItem | undefined, kind: ObjectKind, request: string, focus?: string): Promise<CardItem> {
  const at = from ? await placeBeside(store, from) : { x: 0, y: 0 };
  const object: CardItem = {
    kind: "card",
    id: newId(),
    parentId: from?.id ?? "",
    objectKind: kind,
    request,
    // The words it's about hang it from those words, like any explanation of a phrase.
    ...(from && focus ? { selection: focus } : {}),
    x: at.x,
    y: at.y,
    // A set is a grid of tiles, three across: it needs the room.
    w: kind === "set" ? SOURCE_WIDTH : CARD_WIDTH,
    stage: "reading",
    subject: request,
  };
  await store.add(object);
  return object;
}

/** Finds videos, reading or papers (or draws a diagram) for a request, beside a card; the search runs on. */
export async function findFor(store: CanvasStore, from: CardItem | undefined, kind: ObjectKind, request: string, focus?: string): Promise<CardItem> {
  // Never hung from something removed (a call can remove a failed card and ask again in one turn):
  // it goes on what that card came from, and the removed card's words aren't its focus.
  let near = from ? await store.findItem(from.id) : undefined;
  for (let i = 0; near?.hidden && i < 50; i++) {
    focus = undefined;
    near = near.kind === "card" ? await store.findItem(near.parentId) : undefined;
  }
  from = near?.kind === "card" ? near : undefined;
  const object = await addObject(store, from, kind, request, focus);
  void makeObject(store, object.id);
  return object;
}

// ---- Starting from a link or a statement ----

/**
 * Reads the page a source card links to, keeping its text as the card's page. A page read before
 * (on any canvas) comes from the page store, unless `fresh` asks for it to be fetched again.
 */
export function readSource(store: CanvasStore, cardId: string, fresh = false) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    if (card.origin?.kind !== "page") return;
    await store.update(cardId, { stage: "reading" });
    const linked = card.origin.url;
    const known = fresh ? undefined : await bestRead(linked);
    const page = known ? { url: known.finalUrl, title: known.title, site: known.site ?? "", text: known.text } : await readWebPage(linked);
    if (!known) {
      // A new reading; if the text differs from earlier ones, its shapes are drawn for it.
      const read = { at: new Date().toISOString(), title: page.title, site: page.site, finalUrl: page.url, text: page.text };
      for (const url of new Set([linked, page.url])) await editVersion(url, read);
    }
    await store.update(cardId, {
      stage: "done",
      subject: page.title,
      topic: page.title,
      pageText: page.text,
      origin: { kind: "page", url: page.url, site: page.site, title: page.title },
    });
    void shapePage(store, cardId);
    void shapeSections(store, cardId);
  });
}

// ---- A linked page, restructured into shapes ----

const RESTRUCTURE = `${EXPLAIN}

This time you are not explaining a selection. You are RESTRUCTURING a whole page the reader linked, so they can see
its shape before (or instead of) reading it. Restructure, don't summarize: keep what the page actually says and
how it fits together, in the shape above. Add nothing the page doesn't support, except plain glosses of background.
- "why": the problem or question the page's subject answers.
- "what": what it is, in familiar terms; details are the page's key facts about it.
- "parts": its ingredients as the page defines them (for a definition with several pieces, one entry per piece).
- "together": how the parts combine, as the page says.
- "here": what the page goes on to do, in order: its main sections or results, one step each, 2 to 6 steps,
  reaching all the way to the end of the page.
The page's paragraphs are numbered [P0], [P1], ... Also return "from": an object mapping each piece to the numbers of
the paragraphs it comes from. Keys: "why-0", "why-1", ...; "what-0" for the gist, "what-1", ... for details;
"part-0", ...; "together"; "here-0", .... Leave out pieces that are background, not from the page.
Never write paragraph numbers in the pieces' text; they go only in "from".
A figure is listed as "[P12] (figure: its caption)". When a piece is about what a figure shows, or refers to "the
diagram" or "the figure", include that figure's number in its "from", so the reader sees the figure beside it.`;

// ---- The whole page, section by section, without loss ----

const PRESERVE = `You are restructuring one section of a page into a diagram, for a reader who will study it closely.
Preserve, don't summarize. Every claim, number, date, name, example, quotation and connective (because, so, however,
then, despite) in the section must appear in some piece. You may reorder and regroup, and split long sentences into
several pieces, but leave nothing out, and add nothing the section doesn't say, except a short plain gloss in
parentheses for a term an outsider wouldn't know. Keep the author's own terms.
Group the section's content into blocks, each drawn in the shape that fits it:
- "then": a sequence of events, or a chain of causes and effects, in order: one piece per event or step.
- "steps": a procedure or method, in order.
- "parts": something made of components: each part's name and a note, and "together": what they add up to.
- "split": a contrast between exactly two sides, cases, periods or views: a heading and lines for each.
- "facts": facts about one thing, one per line.
Give each block a short label (2 to 6 words) and "from": the numbers of the paragraphs it carries.
Pieces may be up to about 40 words when that is what it takes to keep the content; never drop a detail to make a piece shorter.
Write math as LaTeX between \\( and \\).
Return JSON only:
{"blocks": [{"shape": "then|steps|parts|split|facts", "label": "...", "from": [3, 4],
  "items": ["..."], "parts": [{"name": "...", "note": "..."}], "together": "...",
  "branches": [{"label": "...", "items": ["..."]}, {"label": "...", "items": ["..."]}]}]}`;

const SECTION_SHAPES = ["then", "steps", "parts", "split", "facts"] as const;

/** A page's sections: the paragraphs from each "## " heading to the next, long ones cut into parts. */
function sectionsOf(paras: string[], title: string): { title: string; start: number; end: number }[] {
  const out: { title: string; start: number; end: number }[] = [];
  let cur = { title, start: 0, end: -1 };
  const close = () => {
    if (cur.end < cur.start) return;
    // Keep each piece of work a size the model can carry whole.
    let size = 0;
    let from = cur.start;
    let part = 1;
    for (let i = cur.start; i <= cur.end; i++) {
      size += paras[i].length;
      if (size > 9000 && i > from) {
        out.push({ title: `${cur.title} (${part++})`, start: from, end: i - 1 });
        from = i;
        size = paras[i].length;
      }
    }
    out.push({ title: part > 1 ? `${cur.title} (${part})` : cur.title, start: from, end: cur.end });
  };
  paras.forEach((p, i) => {
    if (/^## /.test(p)) {
      close();
      cur = { title: p.replace(/^## /, "").trim(), start: i + 1, end: i };
    } else cur.end = i;
  });
  close();
  return out;
}

/** Splits a paragraph into sentences, for keeping it verbatim when nothing else carried it. */
function sentences(p: string): string[] {
  return (p.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [p]).map((s) => s.trim()).filter(Boolean);
}

/** Restructures one section of a page into blocks of shapes, keeping verbatim whatever they don't carry. */
async function shapeSection(paras: string[], sec: { title: string; start: number; end: number }, told: string): Promise<Extension[]> {
  const nums: number[] = [];
  const lines: string[] = [];
  for (let i = sec.start; i <= sec.end; i++) {
    if (/^!\[/.test(paras[i])) continue;
    nums.push(i);
    lines.push(`[P${i}] ${paras[i]}`);
  }
  if (!nums.length) return [];
  const raw = await chatJson<{ blocks?: unknown }>((await loadConfig()).llm, [
    { role: "system", content: PRESERVE },
    { role: "user", content: [`Section: ${sec.title}`, told, lines.join("\n\n")].filter(Boolean).join("\n\n") },
  ]);
  const blocks: Extension[] = [];
  for (const item of Array.isArray(raw.blocks) ? raw.blocks : []) {
    const b = item as Record<string, unknown>;
    const shape = SECTION_SHAPES.find((s) => s === str(b.shape)) ?? "facts";
    const from = (Array.isArray(b.from) ? b.from : [b.from]).flatMap((x) => paraNumbers(String(x ?? ""))).filter((n) => nums.includes(n));
    const block: Extension = { id: newId(), at: "", shape, status: "done", label: str(b.label).slice(0, 80) || undefined, from: [...new Set(from)] };
    if (shape === "parts") {
      block.parts = (Array.isArray(b.parts) ? b.parts : [])
        .map((p) => p as Record<string, unknown>)
        .map((p) => ({ name: str(p.name).slice(0, 200), note: str(p.note).slice(0, 600) }))
        .filter((p) => p.name);
      block.together = str(b.together).slice(0, 600) || undefined;
      if (!block.parts.length) continue;
    } else if (shape === "split") {
      block.branches = (Array.isArray(b.branches) ? b.branches : [])
        .map((x) => x as Record<string, unknown>)
        .map((x) => ({ label: str(x.label).slice(0, 80), items: strs(x.items, 12).map((t) => t.slice(0, 600)) }))
        .slice(0, 2);
      if (block.branches.length < 2) continue;
    } else {
      block.items = strs(b.items, 30).map((t) => t.slice(0, 600));
      if (!block.items.length) continue;
    }
    blocks.push(block);
  }
  // Whatever no block says it carries is kept as it was written: nothing on the page is dropped.
  const carried = new Set(blocks.flatMap((b) => b.from ?? []));
  const left = nums.filter((n) => !carried.has(n));
  if (left.length) {
    blocks.push({
      id: newId(),
      at: "",
      shape: "facts",
      status: "done",
      label: blocks.length ? "Also in this section, as written" : "As written",
      from: left,
      items: left.flatMap((n) => sentences(paras[n])).slice(0, 60),
    });
  }
  return blocks;
}

/** Puts sections the page store has (drawn on any canvas) in place of ones missing or failed here. */
export async function refillSections(store: CanvasStore, cardId: string) {
  const card = (await store.findItem(cardId)) as CardItem | undefined;
  if (card?.kind !== "card" || card.origin?.kind !== "page" || !card.pageText || !card.sections) return;
  const doc = await pageVersion(card.origin.url, card.pageText);
  if (!doc?.sections) return;
  const better = (s: PageSection, i: number) => {
    const k = doc.sections![String(i)];
    return s.status === "failed" && k?.status === "done" && k.start === s.start && k.end === s.end && k.title === s.title ? k : undefined;
  };
  if (!card.sections.some(better)) return;
  await store.edit(cardId, (now) => (now?.kind === "card" && now.sections ? { sections: now.sections.map((s, i) => better(s, i) ?? s) } : null));
}

/** Shapes being drawn right now, by the text they're drawn from, so two canvases share one run. */
const drawing = new Map<string, Promise<unknown>>();

/** Restructures every section of a linked page, in parallel, each saved as it finishes. */
export async function shapeSections(store: CanvasStore, cardId: string) {
  const card = (await store.findItem(cardId)) as CardItem | undefined;
  if (!card?.pageText) return;
  const paras = paragraphs(card.pageText);
  const secs = sectionsOf(paras, card.origin?.title ?? card.subject ?? "The page");
  const told = await readerNotes(store);
  // Sections already restructured for this text (on any canvas) are used as they are.
  const url = card.origin?.kind === "page" ? card.origin.url : "";
  const textHash = hashText(card.pageText);
  const doc = url ? await pageVersion(url, card.pageText) : undefined;
  const read = readOf(card);
  const kept = (sec: (typeof secs)[number], i: number) => {
    const k = doc?.sections?.[String(i)];
    return k && k.status === "done" && k.start === sec.start && k.end === sec.end && k.title === sec.title ? k : undefined;
  };
  await store.update(cardId, { sections: secs.map((sec, i) => kept(sec, i) ?? { ...sec, status: "working" as const }) });
  const save = (i: number, patch: Partial<PageSection>) =>
    store.edit(cardId, (now) => (now?.kind === "card" && now.sections ? { sections: now.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : null));
  await Promise.all(
    secs.map(async (sec, i) => {
      if (kept(sec, i)) return;
      try {
        // The same section of the same text being drawn for another canvas right now: share it.
        const key = `${textHash}:${i}:${sec.start}-${sec.end}`;
        let run = drawing.get(key) as Promise<Extension[]> | undefined;
        if (!run) {
          run = shapeSection(paras, sec, told);
          drawing.set(key, run);
          void run.catch(() => {}).finally(() => drawing.delete(key));
        }
        const blocks = (await run).map((b) => ({ ...b, at: `sec-${i}` }));
        await save(i, { status: "done", blocks });
        if (url && read) await editVersion(url, read, (v) => ({ ...v, sections: { ...v.sections, [String(i)]: { ...sec, status: "done", blocks } } })).catch(() => {});
      } catch (err) {
        // Even a failed section keeps its content, as written.
        const nums = [...Array(sec.end - sec.start + 1).keys()].map((k) => sec.start + k).filter((n) => !/^!\[/.test(paras[n]));
        await save(i, {
          status: "failed",
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
          blocks: nums.length ? [{ id: newId(), at: `sec-${i}`, shape: "facts", status: "done", label: "As written", from: nums, items: nums.flatMap((n) => sentences(paras[n])).slice(0, 60) }] : [],
        });
      }
    }),
  );
}

/** Paragraph numbers in a reference like "P3", "P3-P5", "3, 7" or "P23–45"; a range gives at most 4. */
function paraNumbers(ref: string): number[] {
  const out: number[] = [];
  for (const m of ref.matchAll(/(\d+)(?:\s*[-–]\s*P?\s*(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= Math.min(b, a + 3); n++) out.push(n);
  }
  return out;
}

/** Draws a linked page as shapes, each piece pointing back at the paragraphs it came from. */
export async function shapePage(store: CanvasStore, cardId: string) {
  const card = (await store.findItem(cardId)) as CardItem | undefined;
  if (!card?.pageText) return;
  const url = card.origin?.kind === "page" ? card.origin.url : "";
  const doc = url ? await pageVersion(url, card.pageText) : undefined;
  if (doc?.shape) {
    // Drawn before, from this same text: no need to draw it again.
    await store.update(cardId, { sem: doc.shape.sem, anchors: doc.shape.anchors, shaping: "done" });
    return;
  }
  await store.update(cardId, { shaping: "working" });
  try {
    const paras = paragraphs(card.pageText);
    // The whole page, always: a long page has each paragraph shortened rather than its end cut off,
    // since its end is often the point (a history's wars, a paper's results). Headings stay whole.
    const line = (p: string, i: number, cap: number) => {
      // A figure is numbered too, by its caption, so a piece about it can say where it is.
      const fig = /^!\[([^\]]*)\]/.exec(p);
      if (fig) return `[P${i}] (figure${fig[1] ? `: ${fig[1].slice(0, 120)}` : ""})`;
      if (/^## /.test(p)) return `[P${i}] ${p}`;
      return `[P${i}] ${p.length > cap ? `${p.slice(0, cap)}…` : p}`;
    };
    let numbered: string[] = [];
    for (const cap of [700, 450, 300, 200, 130, 80]) {
      numbered = paras.map((p, i) => line(p, i, cap));
      if (numbered.join("\n\n").length <= 60_000) break;
    }
    const told = await readerNotes(store);
    const raw = await chatJson<Record<string, unknown>>((await loadConfig()).llm, [
      { role: "system", content: RESTRUCTURE },
      {
        role: "user",
        content: [`Page: ${card.origin?.title ?? card.subject ?? ""}`, told, `The page:\n${numbered.join("\n\n")}`].filter(Boolean).join("\n\n"),
      },
    ]);
    const sem = cleanSem(raw, 6);
    if (!sem.why.length && !sem.what.gist) throw new Error("no shapes in the answer");
    const found: Record<string, number[]> = {};
    const from = raw.from && typeof raw.from === "object" ? (raw.from as Record<string, unknown>) : {};
    for (const [key, v] of Object.entries(from)) {
      found[key] = (Array.isArray(v) ? v : [v]).flatMap((x) => paraNumbers(String(x)));
    }
    // Models often cite paragraphs inline ("… [P23-P45]") instead: take those, and take them out of the text.
    const cite = (key: string, text: string) => {
      const refs = [...text.matchAll(/\s*\[(P\s*\d+[^\]]*)\]/g)];
      if (refs.length) found[key] = [...(found[key] ?? []), ...refs.flatMap((m) => paraNumbers(m[1]))];
      return text.replace(/\s*\[(P\s*\d+[^\]]*)\]/g, "").trim();
    };
    sem.why = sem.why.map((t, i) => cite(`why-${i}`, t));
    sem.here = sem.here.map((t, i) => cite(`here-${i}`, t));
    const whats = [sem.what.gist, ...sem.what.details].filter(Boolean).map((t, i) => cite(`what-${i}`, t));
    sem.what = { gist: whats[0] ?? "", details: whats.slice(1) };
    sem.parts = sem.parts.map((p, i) => ({ ...p, meaning: cite(`part-${i}`, p.meaning), note: cite(`part-${i}`, p.note) }));
    sem.together = cite("together", sem.together);
    const anchors: Record<string, number[]> = {};
    for (const [key, ns] of Object.entries(found)) {
      const ok = [...new Set(ns)].filter((n) => n < paras.length);
      if (/^(why|what|part|here)-\d+$|^together$/.test(key) && ok.length) anchors[key] = ok.slice(0, 4);
    }
    await store.update(cardId, { sem, anchors, shaping: "done" });
    const read = readOf(card);
    if (url && read) await editVersion(url, read, (v) => ({ ...v, shape: { sem, anchors } })).catch(() => {});
    // The page itself may be course material (lecture notes, a syllabus).
    const title = card.origin?.title ?? card.subject ?? "";
    if (url) void mapCourses(store, cardId, card.subject ?? title, [{ n: 1, url, title, snippet: card.pageText.slice(0, 600), searcher: "page" }]);
  } catch {
    await store.update(cardId, { shaping: "failed" });
  }
}
