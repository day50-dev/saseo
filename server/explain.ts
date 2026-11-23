// The librarian's loop for one card: read the region, go fish, write a descending
// explanation from what was found, then check that it doesn't climb.
import { CARD_WIDTH, paragraphs, type CardItem, type FoundSource, type ImageItem, type Item, type ObjectKind, type Rect, type Register, type RegisterNote, type Sem, type Video } from "../shared/canvas.ts";
import { SEARCHER_IDS } from "../shared/providers.ts";
import { readFile } from "node:fs/promises";
import { assetPath, type CanvasStore, getCanvasInfo, newId } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chat, chatJson, chatStream, decideChoice, decideYesNo, type Message, systemOneConfigured } from "./llm.ts";
import { searchArxiv } from "./arxiv.ts";
import { readPage as readWebPage } from "./pages.ts";
import { runSearch } from "./providers.ts";
import { partialSvg, sanitizeSvg, svgLabels } from "./svg.ts";

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

/** A card's explanation as plain text: the structure for newer cards, paragraphs for older ones. */
function cardText(c: CardItem): string {
  if (c.origin) return c.pageText ?? c.origin.title;
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
    root.pageText ? `The whole page reads:\n${root.pageText}` : "",
    `Then, step by step, they asked about:`,
    ...chain.map((c, i) => `${i + 1}. ${c.subject ?? c.selection ?? "?"}${c.sem?.what.gist ? `: ${c.sem.what.gist}` : ""}`),
    `The full explanation of "${parent.subject ?? "the previous card"}" that they selected words from:`,
    cardText(parent),
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
function cleanSem(raw: Record<string, unknown>): Sem {
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
    here: strs(raw.here ?? raw.how, 3),
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
  const messages: Message[] = [
    { role: "system", content: EXPLAIN },
    { role: "user", content: lines.join("\n\n") },
  ];
  let sem = cleanSem(await chatJson<Record<string, unknown>>(config.llm, messages));
  if (!sem.why.length && !sem.what.gist) throw new Error("The model's answer had no why and no what");
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
        const second = cleanSem(await chatJson<Record<string, unknown>>(config.llm, messages));
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
  await store.update(card.id, { stage: "done", sem, sources, climb, rewritten });
}

async function search(query: string): Promise<FoundSource[]> {
  const config = await loadConfig();
  const enabled = SEARCHER_IDS.filter((id) => config.searchers[id].enabled);
  if (!enabled.length) return [];
  return mergeHits(await runSearch(config, query, enabled, 4));
}

async function guard(store: CanvasStore, cardId: string, run: () => Promise<void>) {
  const limit = (await loadConfig()).llm.timeoutSeconds;
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || /aborted due to timeout/.test(message));
    await store.update(cardId, {
      stage: "failed",
      error: timedOut
        ? `The language model didn't answer within ${limit} seconds. It may be busy with another card; retry, or raise the timeout in Settings.`
        : message,
    });
  }
}

/** For a rectangle on an image: `marked` is the whole page with the rectangle drawn, `crop` the region. */
export function explainRegion(store: CanvasStore, cardId: string, images: { marked: string; crop: string }) {
  return guard(store, cardId, async () => {
    const config = await loadConfig();
    const content = [
      { type: "text" as const, text: "Here is the page and the part I selected." },
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
      const rect = keys.has(k) ? toRect(v, img) : null;
      if (rect) looks[k] = rect;
    }
    await store.update(cardId, { looks, looking: "done" });
  } catch {
    await store.update(cardId, { looking: "failed" });
  }
}

const RESOLVE = `A reader selected some words inside an explanation because they want to know more.
Work out what idea those words refer to IN THAT SENTENCE. Explanations often use everyday stand-ins
("an invisible push", "spread-out flow") for a real concept, and searching the literal words finds
nothing useful. Name the real concept the way an introductory textbook would title it.

Also judge the REGISTER of the selected words as used in that sentence. Mathematical writing switches
without warning between strict terms of art and casual description, and both look like plain English:
- "term": a technical term with a strict definition (e.g. "energy space", "well-posed", "Coulomb gauge")
- "idiom": a standard insider phrase or move with a precise meaning rarely spelled out (e.g. "closes the bootstrap")
- "casual": everyday words used loosely, often pointing at something precise (e.g. "+ better", "the worst term", "rougher")
- "notation": ONLY a symbol or formula visibly used loosely (in quote marks, with ≈, "morally"), meaning "roughly this"; a precise symbol (L^1(R^2), a defined function) is a "term"
Return JSON only, no prose:
{"concept": "the standard name of the idea, 2-6 words",
 "searchQuery": "2-6 plain words for BEGINNER material (intro notes, textbook chapters, videos) on that concept, without terms specific to the page",
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
  const context = await trail(store, card);
  const quoted = card.context ? `“${selection}” in: ${card.context}` : selection;
  const register = card.register;
  await store.update(cardId, { stage: "searching" });
  const sources = await search(card.searchQuery ?? `${selection} explained introduction`);
  await store.update(cardId, { stage: "writing", sources });
  const guidance = register ? `${REGISTER_GUIDANCE[register.register]}${register.means ? ` (${register.means})` : ""}` : "";
  await write(store, card, card.subject ?? selection, quoted, topic, path, sources, [context, guidance].filter(Boolean).join("\n\n"));
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

type Intent = "answer" | ObjectKind;

const INTENT_CRITERIA: Record<Intent, string> = {
  answer: "A question to be answered in words.",
  videos: "A request for videos, lectures or talks to watch.",
  links: "A request for reading: articles, notes, papers, textbooks or other pages.",
  diagram: "A request to draw, sketch, picture or diagram something.",
  papers: "A request for research papers, preprints or arXiv articles.",
};
const isIntent = (v: unknown): v is Intent => typeof v === "string" && v in INTENT_CRITERIA;

const INTENT = `A reader typed a message in the conversation box on a card about a topic they are studying.
Decide what they want: an answer in words, or an object made for them.
Return JSON only: {"kind": "answer" | "videos" | "links" | "diagram" | "papers", "request": "what they asked for, restated in a few words"}
- "videos": they ask for videos, lectures or talks to watch.
- "links": they ask for things to read: articles, notes, papers, textbook chapters.
- "diagram": they ask you to draw, sketch, picture or diagram something.
- "papers": they ask for research papers, preprints, or arXiv.
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
  if (c.objectKind === "diagram") return 1100;
  if (c.objectKind === "links") return 900;
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

const QUERY = `Write a short web search query, 2-6 plain words, for BEGINNER material on what the reader asked for, given the card it was asked about.
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
    const about = from?.kind === "card" ? await describe(store, from.id) : { name: "this", text: "" };
    const request = card.request ?? "";
    const config = await loadConfig();
    const enabled = SEARCHER_IDS.filter((id) => config.searchers[id].enabled);

    if (card.objectKind === "videos") {
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
      await store.update(cardId, { stage: "done", subject: `Videos: ${request}`, object: { type: "videos", videos: videos.slice(0, 6) } });
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
      const { papers } = await searchArxiv(q, { max: 8 });
      if (!papers.length) throw new Error(`arXiv found nothing for "${q}".`);
      await store.update(cardId, { stage: "done", subject: `Papers: ${request}`, object: { type: "papers", papers } });
    } else if (card.objectKind === "diagram") {
      await store.update(cardId, { stage: "writing" });
      // Draw it as it streams: each frame is the SVG so far, closed and cleaned, shown to viewers
      // but not logged. Only the finished diagram is recorded.
      let lastFrame = 0;
      let drawn = "";
      try {
        drawn = await chatStream(
          config.llm,
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
    }
  });
}

const MADE: Record<ObjectKind, string> = {
  videos: "Finding videos",
  links: "Finding reading",
  diagram: "Drawing a diagram",
  papers: "Searching arXiv",
};

const PAPER_QUERY = `Write an arXiv search for research papers on what the reader asked for, given the card it was asked about.
Use 2-5 precise technical keywords that would appear in paper titles or abstracts (names of equations, objects, methods).
Return JSON only: {"query": "..."}`;

/** Handles the latest message in a card's conversation: answers it, or makes what it asks for. */
export async function handleChat(store: CanvasStore, cardId: string) {
  const card = (await store.findItem(cardId)) as CardItem;
  const last = [...(card.chat ?? [])].reverse().find((m) => m.role === "user");
  if (!last) return store.update(cardId, { chatPending: false });
  const { kind, request } = await decideIntent(last.text, card.subject ?? card.selection ?? "this");
  if (kind === "answer") return chatAbout(store, cardId);

  const at = await placeBeside(store, card);
  const object: CardItem = {
    kind: "card",
    id: newId(),
    parentId: card.id,
    objectKind: kind,
    request,
    x: at.x,
    y: at.y,
    w: CARD_WIDTH,
    stage: "reading",
    subject: request,
  };
  await store.add(object);
  await store.record({
    type: "chat",
    id: cardId,
    message: { role: "assistant", text: `${MADE[kind]}: ${request}`, at: new Date().toISOString(), objectId: object.id },
  });
  await store.update(cardId, { chatPending: false });
  await makeObject(store, object.id);
}

// ---- Starting from a link or a statement ----

/** Reads the page a source card links to, keeping its text as the card's page. */
export function readSource(store: CanvasStore, cardId: string) {
  return guard(store, cardId, async () => {
    const card = (await store.findItem(cardId)) as CardItem;
    if (card.origin?.kind !== "page") return;
    await store.update(cardId, { stage: "reading" });
    const page = await readWebPage(card.origin.url);
    await store.update(cardId, {
      stage: "done",
      subject: page.title,
      topic: page.title,
      pageText: page.text,
      origin: { kind: "page", url: page.url, site: page.site, title: page.title },
    });
    void shapePage(store, cardId);
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
- "here": what the page goes on to do, in order: its main sections or results, one step each.
The page's paragraphs are numbered [P0], [P1], ... Also return "from": an object mapping each piece to the numbers of
the paragraphs it comes from. Keys: "why-0", "why-1", ...; "what-0" for the gist, "what-1", ... for details;
"part-0", ...; "together"; "here-0", .... Leave out pieces that are background, not from the page.
Never write paragraph numbers in the pieces' text; they go only in "from".
A figure is listed as "[P12] (figure: its caption)". When a piece is about what a figure shows, or refers to "the
diagram" or "the figure", include that figure's number in its "from", so the reader sees the figure beside it.`;

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
  await store.update(cardId, { shaping: "working" });
  try {
    const paras = paragraphs(card.pageText);
    const numbered: string[] = [];
    let size = 0;
    for (const [i, p] of paras.entries()) {
      // A figure is numbered too, by its caption, so a piece about it can say where it is.
      const fig = /^!\[([^\]]*)\]/.exec(p);
      const line = fig ? `[P${i}] (figure${fig[1] ? `: ${fig[1].slice(0, 200)}` : ""})` : `[P${i}] ${p.slice(0, 700)}`;
      if ((size += line.length) > 20_000) break;
      numbered.push(line);
    }
    const told = await readerNotes(store);
    const raw = await chatJson<Record<string, unknown>>((await loadConfig()).llm, [
      { role: "system", content: RESTRUCTURE },
      {
        role: "user",
        content: [`Page: ${card.origin?.title ?? card.subject ?? ""}`, told, `The page:\n${numbered.join("\n\n")}`].filter(Boolean).join("\n\n"),
      },
    ]);
    const sem = cleanSem(raw);
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
  } catch {
    await store.update(cardId, { shaping: "failed" });
  }
}
