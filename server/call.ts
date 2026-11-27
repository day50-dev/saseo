// A call with the librarian: you talk while pointing at things on the canvas, it answers aloud
// and changes the canvas as it goes (grows a piece, opens a deeper card). Speech runs on
// OpenAI-compatible servers you point it at: Kokoro for speaking, a /transcribe endpoint
// (faster-whisper) for listening. See docs/DESIGN.md, "A call with the librarian".
import { CARD_WIDTH, type CardItem, EXTENSION_SHAPES, type Extension, type ExtensionShape, type NoteItem, type ObjectKind } from "../shared/canvas.ts";
import { type CanvasStore, getCanvasInfo, newId } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chat, type Message } from "./llm.ts";
import { speak } from "./providers.ts";

// Listening is a server named in the environment; speaking is set up in Settings (config.tts).
export const SPEECH = {
  stt: process.env.LIBRARIAN_STT_URL ?? "",
};

/** Whether this server can speak aloud: a speech endpoint is set in Settings. */
export const canSpeak = async () => Boolean((await loadConfig()).tts.baseUrl);

/** Audio in, words out. `hint` primes the recogniser with the canvas's own vocabulary. */
export async function listen(audio: ArrayBuffer, hint: string): Promise<string> {
  const r = await fetch(`${SPEECH.stt.replace(/\/$/, "")}/transcribe`, {
    method: "POST",
    body: audio,
    headers: { "content-type": "application/octet-stream", ...(hint ? { "x-prompt": hint.replace(/[^\x20-\x7e]/g, " ").slice(0, 400) } : {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`speech recognition: HTTP ${r.status}`);
  const text = String(((await r.json()) as { text?: string }).text ?? "").trim();
  // An open microphone hears rooms, not just people; on noise the recogniser invents these.
  return /^(thank you|thanks|thanks for watching|you|bye|\.+|\[.*\]|\(.*\))[.!?]*$/i.test(text) ? "" : text;
}

/** Words in, speech out (wav), from the speech endpoint in Settings. */
export async function say(text: string): Promise<ArrayBuffer> {
  return speak((await loadConfig()).tts, text);
}

export interface Pointing {
  /** The card under the pointer or holding the selection. */
  cardId?: string;
  /** The piece of its diagram: a Sem key ("why-1", "cat-what") or a grown piece ("x…"). */
  key?: string;
  /** The words of that piece, as shown. */
  pieceText?: string;
  /** Words selected on the canvas. */
  selection?: string;
  /** The sentence or line those words sit in. */
  selectionContext?: string;
  /** A thing inside a figure, in the figure's own terms: "Berlin (place 2 of 4)", "x = 1.5 on the plot". */
  figure?: string;
}

export interface Turn {
  role: "you" | "librarian";
  text: string;
}

/** A thing numbered on screen for the reader to pick: a card, or a piece of one. */
export interface Mark {
  n: number;
  cardId: string;
  key?: string;
  label: string;
}

/**
 * What the page knows besides the words, sent with each turn but shown to the model only when it
 * asks (or, for the pointer at the moment of "this", when it decides what "this" means).
 */
export interface CallContext {
  /** Where the pointer was while they spoke: ms from the start of speaking. */
  timeline?: { at: number; p: Pointing }[];
  /** How long they spoke, ms. */
  spoke?: number;
  /** Cards at least partly on screen. */
  visible?: string[];
  /** What they did lately, in the canvas's terms, newest last. */
  recent?: { ago: number; what: string }[];
  /** Numbered on screen last turn, still showing. */
  marks?: Mark[];
  /** The number they picked, by clicking it or saying it. */
  picked?: number;
  /** What they typed or pasted into the call (a link, a passage), numbered; `fresh` since they last spoke. */
  sent?: { n: number; text: string; fresh?: boolean }[];
}

const CALL = `You are a research librarian on a voice call with a curious, intelligent reader who is not a specialist.
They are looking at a canvas of explanations, figures and finds, and they point at things while they talk.
Answer the way you'd talk on the phone: warm, plain, short. One to three sentences, no lists, no markdown, no citations,
no LaTeX (say math in words: "A sub j", "the integral of"). Descend: explain with ideas more familiar than what they ask about.

Be simple and direct. You are told only what they are pointing at or have selected, and what was said. That is almost always
enough: answer about that thing. Don't speculate about the rest of the canvas.
"This", "that", "here", "this part" mean what they selected, else what they were pointing at when they said it (you're told).

Only when their words refer to something you can't identify from that ("the other one", "the map from before", "what I was
just looking at", "those two"), or you need a card's content to answer, look it up first: reply
{"look": [{"tool": "...", ...}]} and you'll get the answers. Tools:
- {"tool": "card", "id": "..."}: what a card or note holds, with its pieces' keys (or the pointed card, without an id).
- {"tool": "cards"}: every card and note on the canvas: id, kind, title (a note's words), and which are on screen.
The canvas also holds notes: free-form words the reader (or you) wrote, read as they are. "My note", "what I wrote"
mean one of those; when they point at or select in a note, you're told what it says. Never claim to see something you
weren't told or didn't look up.
- {"tool": "recent"}: what they did lately: what they looked at and clicked, newest last.
- {"tool": "goals"}: what they're after on this canvas.
If, even so, it could be more than one thing, don't guess: number the candidates on screen and ask, with the "mark" action,
saying something like "Which one? I've numbered them: just say the number."

You can change the canvas while you talk, with up to three actions:
- {"kind": "grow", "shape": "..."}: add a shape to the piece they're pointing at. Shapes: aside (say more), why
  (reasons leading up to it), then (what follows), steps (how it's done), parts (break it down), split (two ways or
  cases), example (a worked example), facts (more facts). Use it when they ask for more about something on the
  canvas, or when a diagram would help more than talk.
- {"kind": "descend", "phrase": "..."}: open a new card that explains a phrase (they selected it, or it's in the piece
  they point at). Use it when they ask what a term means and it deserves a full explanation.
- {"kind": "find", "find": "set" | "gallery" | "videos" | "links" | "papers" | "diagram" | "notebook" | "table" | "plot" | "graph" | "map", "request": "..."}:
  put something new on the canvas: set (a collection to look through as a grid of cards: the top artists, key works,
  notable people or places of something; "list", "the top", "the main ones", "show me some"), gallery (pictures to look
  through: what something looks or looked like, artwork, photographs, drawings), videos (lectures, explainers), links (reading), papers (arXiv), diagram (draw one),
  notebook (a runnable example), table (figures and data, read off real pages), plot (functions, curves or data on
  x-y axes), graph (nodes and edges: graph theory, a network) or map (places, routes, countries). "request" says what,
  in a few words.
- {"kind": "remove", "ids": ["..."]}: take cards off the canvas (they can undo it). Only cards they clearly mean;
  look up their ids with "cards" if you don't have them. Never guess here: if more than one card fits their words
  ("the other graph" with two graphs, "the chart" with a plot and a table, "that" with nothing pointed at), mark them and ask.
- {"kind": "open", "text": "..."}: put something new on the canvas from a link or words: a web page (read and drawn
  as shapes), a YouTube video, a PDF (its pages), or a question or statement (explained). "text" is the link or the
  words themselves; for something they typed into the call, "text" can be just "text 1". Use it when they ask you to
  open, add or put up a link or something they sent, or to start on a new question of its own.
- {"kind": "relate", "ids": ["id1", "id2"]}: connect two cards (or a card and a slide) to show how they're related: a new
  card hangs from both with a Y connector and explains the relationship. Use it when they ask to connect, link, relate or
  compare two things on the canvas. Use the ids you're given (pointed at, or from "cards"); "these two" are what they
  pointed at as they spoke. Never say you can't connect cards: this is how.
- {"kind": "note", "text": "..."}: leave a written note on the canvas, beside what they're pointing at (or loose).
  Use it when they ask you to note, jot down or remember something, or when something is worth keeping for later
  that the canvas doesn't show: an open question, a caveat, something to come back to. Write the note itself, short,
  in plain words (their words when they dictate it), not a description of it. Say briefly that you've noted it.
- {"kind": "mark", "marks": [{"card": "id", "piece": "key (optional)", "label": "two or three words"}]}: number 2 to 5
  candidates on screen so they can say which they mean.
Your words say briefly what you're doing ("Let me break that down on the card.", "I'll take those two off.").
NEVER say you did, are doing or will do anything to the canvas that isn't one of your actions this turn: if they ask
for something you can't do (move or resize things, for instance), say so plainly.
Reply with JSON only: {"look": [...]} to look something up, or {"say": "...", "actions": [...]} (actions may be []).`;

const DEICTIC = /^(this|that|these|those|here|there)$/i;

/** What a card holds, in the words someone might use for it. */
const KIND_WORDS: Record<string, string[]> = {
  papers: ["papers", "paper", "arxiv"],
  links: ["reading", "links", "link", "articles"],
  videos: ["videos", "video", "lectures"],
  diagram: ["diagram", "drawing"],
  notebook: ["notebook", "code"],
  table: ["table", "data"],
  plot: ["plot", "chart"],
  graph: ["graph", "network"],
  map: ["map"],
  set: ["set", "list", "collection", "catalog"],
  gallery: ["gallery", "pictures", "images", "photos"],
};

/**
 * The card or note a model's reference means: its id, or (when it wrote something else, like
 * "papers" or a title) the one card of that kind, or the one whose title contains it. Undefined
 * when nothing, or more than one thing, fits.
 */
export function resolveRef(ref: string, cards: CardItem[], notes: NoteItem[] = []): string | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  if (cards.some((c) => c.id === r) || notes.some((n) => n.id === r)) return r;
  const low = r.toLowerCase().replace(/\s+card$/, "");
  const kind = Object.entries(KIND_WORDS).find(([, words]) => words.includes(low))?.[0];
  const of = kind ? cards.filter((c) => c.objectKind === kind) : [];
  if (of.length === 1) return of[0].id;
  if (of.length > 1) return undefined;
  const titled = cards.filter((c) => (c.subject ?? c.selection ?? c.request ?? "").toLowerCase().includes(low));
  if (titled.length === 1) return titled[0].id;
  const noted = notes.filter((n) => n.text.toLowerCase().includes(low));
  return !titled.length && noted.length === 1 ? noted[0].id : undefined;
}

/** One line for a thing pointed at: its card's title, and the piece or figure part. */
/** One line for a note: who wrote it, what it's about, and its words. */
export function noteContent(n: NoteItem, cards: CardItem[] = []): string {
  const on = n.on ? cards.find((c) => c.id === n.on!.id) : undefined;
  const about = on ? ` beside the card "${on.subject ?? on.selection ?? on.request ?? "a card"}"${n.on?.quote ? ` (about "${n.on.quote.slice(0, 200)}")` : ""}` : "";
  return `${n.id}: a note ${n.by === "you" ? "they wrote" : "you left"}${about}, at ${n.at}. It says: "${n.text.slice(0, 2000)}"`;
}

export function describePointing(p: Pointing, cards: CardItem[], notes: NoteItem[] = []): string {
  const note = p.cardId ? notes.find((n) => n.id === p.cardId) : undefined;
  if (note) return `${note.by === "you" ? "their" : "your"} note, which says "${note.text.slice(0, 1500)}"`;
  const card = p.cardId ? cards.find((c) => c.id === p.cardId) : undefined;
  if (!card) return "";
  const title = `"${card.subject ?? card.selection ?? card.request ?? "a card"}"${card.objectKind ? ` (${card.objectKind === "links" ? "reading" : card.objectKind} card)` : ""}`;
  if (p.figure) return `${p.figure}, on ${title}`;
  if (p.pieceText) return `"${p.pieceText}", on the card ${title}`;
  return `the card ${title}`;
}

/**
 * What each "this" or "that" pointed at: the pointer at about the moment the word was said,
 * from where it falls in what they said. Different from the last thing pointed at, when the hand
 * moved on while they talked ("compare this … with that").
 */
export function deixis(text: string, ctx: CallContext): { word: string; p: Pointing }[] {
  const tl = ctx.timeline ?? [];
  if (!tl.length || !ctx.spoke) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const out: { word: string; p: Pointing }[] = [];
  words.forEach((w, i) => {
    const bare = w.replace(/[^\w']/g, "");
    if (!DEICTIC.test(bare)) return;
    const t = ((i + 0.5) / words.length) * ctx.spoke!;
    const at = [...tl].reverse().find((e) => e.at <= t) ?? tl[0];
    if (at.p.cardId) out.push({ word: bare.toLowerCase(), p: at.p });
  });
  return out;
}

export const objectSummary = (c: CardItem): string => {
  const o = c.object;
  if (!o) return "";
  switch (o.type) {
    case "map":
      return `A map${o.route ? " of a route, in order" : ""}. Places: ${o.places.map((p, i) => `${i + 1}. ${p.name}${p.note ? ` (${p.note})` : ""}`).join("; ")}${o.areas?.length ? `. Outlined: ${o.areas.map((a) => a.name).join(", ")}` : ""}`;
    case "graph":
      return `A graph of ${o.nodes.length} nodes. Nodes: ${o.nodes.map((n) => n.label).join(", ")}. Edges: ${o.edges.slice(0, 40).map((e) => `${e.from}→${e.to}${e.label ? ` (${e.label})` : ""}`).join(", ")}`;
    case "plot":
      return `A plot. x: ${o.plot.x.label ?? "x"}; y: ${o.plot.y.label ?? "y"}. ${o.plot.series.map((s) => s.label ?? s.fn ?? "points").join("; ")}${o.caption ? `. ${o.caption}` : ""}`;
    case "table":
      return `A table: ${o.columns.join(" | ")}\n${o.rows.slice(0, 15).map((r) => r.map((v) => v ?? "").join(" | ")).join("\n")}`;
    case "videos":
      return `Videos: ${o.videos.map((v) => v.title).join("; ")}`;
    case "links":
      return `Reading: ${o.links.map((l) => l.title).join("; ")}`;
    case "papers":
      return `Papers: ${o.papers.map((p) => p.title).join("; ")}`;
    case "diagram":
      return `A diagram. ${o.caption}`;
    case "notebook":
      return `A notebook: ${o.title}`;
    case "gallery":
      return `Pictures, "${o.title}": ${o.images.map((im, i) => `${i + 1}. ${im.caption}${im.when ? ` (${im.when})` : ""}`).join("; ")}`;
    case "set":
      return `A set of cards, "${o.title}": ${o.entries.map((e, i) => `${i + 1}. ${e.title}${e.subtitle ? ` (${e.subtitle})` : ""}`).join("; ")}`;
  }
};

export function cardContent(c: CardItem): string {
  const head = `${c.id}: "${c.subject ?? c.selection ?? c.request ?? "a card"}"`;
  if (c.sem) {
    const s = c.sem;
    const pieces = [
      ...s.why.map((t, i) => `[why-${i}] ${t}`),
      `[what-0] ${s.what.gist}`,
      ...s.what.details.map((t, i) => `[what-${i + 1}] ${t}`),
      ...s.parts.map((p, i) => `[part-${i}] ${p.symbol} = ${p.meaning}`),
      ...s.here.map((t, i) => `[here-${i}] ${t}`),
      ...(c.ext ?? []).flatMap((e) => (e.items ?? []).slice(0, 4).map((t) => `[${e.id}] ${t}`)),
    ];
    return `${head}\n${pieces.join("\n").slice(0, 4000)}`;
  }
  if (c.object) return `${head}\n${objectSummary(c).slice(0, 3000)}`;
  return `${head}\n${(c.pageText ?? "").slice(0, 2000)}`;
}

/** One turn of the call: what to say back, and what was done on the canvas. */
export async function callTurn(
  store: CanvasStore,
  text: string,
  pointing: Pointing,
  history: Turn[],
  hooks: {
    grow: (card: CardItem, ext: Extension) => Promise<void>;
    descend: (card: CardItem, phrase: string) => Promise<CardItem>;
    /** `focus`: the words on `near` it's about (selected, or the piece pointed at). */
    find: (near: CardItem | undefined, kind: ObjectKind, request: string, focus?: string) => Promise<CardItem>;
    /** Hides cards (and what hangs from them); returns everything hidden. */
    remove: (ids: string[]) => Promise<string[]>;
    /** Opens a link or words as something new on the canvas, beside `near`; returns what was made. */
    open?: (input: string, near?: CardItem) => Promise<{ id: string; what: string }>;
    /** A card relating two things, hung from both. */
    relate?: (a: string, b: string) => Promise<CardItem | null>;
    /** Leaves a note, about a card (and a piece of it) when one is pointed at. */
    note?: (text: string, on?: { id: string; key?: string; quote?: string }) => Promise<unknown>;
  },
  ctx: CallContext = {},
): Promise<{ say: string; did?: string; removed?: string[]; marks?: Mark[]; looked?: string[]; opened?: string }> {
  const state = await store.getState();
  const cards = state.items.filter((i): i is CardItem => i.kind === "card" && !i.hidden);
  // A number picked from the marks is what they mean now.
  const pick = ctx.picked !== undefined ? ctx.marks?.find((m) => m.n === ctx.picked) : undefined;
  if (pick) {
    pointing = { cardId: pick.cardId, ...(pick.key ? { key: pick.key } : {}) };
  }
  // "This" is what was under the pointer as it was said, unless words are selected.
  const said = pointing.selection ? [] : deixis(text, ctx);
  if (said.length && !pick) pointing = said[0].p;
  const card = pointing.cardId ? cards.find((c) => c.id === pointing.cardId) : undefined;
  const canvasNotes = state.items.filter((i): i is NoteItem => i.kind === "note" && !i.hidden);
  const note = pointing.cardId ? canvasNotes.find((n) => n.id === pointing.cardId) : undefined;
  const info = await getCanvasInfo(store.id);
  const notes = (info?.reader ?? []).map((n) => n.a).filter(Boolean);

  // The glance: only what nearly every turn needs.
  const distinct = said.filter((d, i) => said.findIndex((e) => e.p.cardId === d.p.cardId && e.p.key === d.p.key && e.p.figure === d.p.figure) === i);
  const lines = [
    notes.length ? `About them: ${notes.join("; ")}` : "",
    pointing.selection
      ? `They have SELECTED: "${pointing.selection}"${pointing.selectionContext ? ` (in: "${pointing.selectionContext}")` : ""}${card ? `, on "${card.subject ?? card.selection}"` : note ? `, in ${describePointing(pointing, cards, canvasNotes)}` : ""}`
      : "",
    pick
      ? `You asked them which one they meant and numbered the candidates. They picked number ${pick.n}: ${describePointing(pointing, cards, canvasNotes)} (id ${pick.cardId}). That is the thing their earlier request was about: do it to this one.`
      : "",
    !pick && distinct.length > 1
      ? `As they spoke they pointed at, in order: ${distinct.map((d) => `"${d.word}" = ${describePointing(d.p, cards, canvasNotes)}`).join("; ")}`
      : !pick && !pointing.selection && (card || note)
        ? `Pointing at: ${describePointing(pointing, cards, canvasNotes)}`
        : !pick && !pointing.selection
          ? "Not pointing at anything."
          : "",
    ctx.sent?.length
      ? `They typed into the call (they may say "the link", "what I sent", "text 2"):\n${ctx.sent
          .slice(-10)
          .map((t) => `[text ${t.n}]${t.fresh ? " (new, sent since they last spoke)" : ""}: ${t.text.slice(0, 2000)}`)
          .join("\n")}`
      : "",
    ctx.marks?.length && !pick ? `Numbered on screen from your last turn: ${ctx.marks.map((m) => `${m.n} = ${m.label}`).join("; ")}` : "",
    history.length ? `The call so far:\n${history.slice(-8).map((t) => `${t.role === "you" ? "Reader" : "You"}: ${t.text}`).join("\n")}` : "",
    `They just said: "${text}"`,
  ].filter(Boolean);

  // Look-ups, on request: at most two rounds, then it answers with what it has.
  const tool = (t: Record<string, unknown>): string => {
    switch (t.tool) {
      case "card": {
        const id = t.id ? resolveRef(String(t.id), cards, canvasNotes) : undefined;
        if (t.id && !id) return `No card or note "${String(t.id)}": look up the ids with {"tool": "cards"}.`;
        const n = canvasNotes.find((x) => x.id === id) ?? (t.id ? undefined : note);
        if (n) return noteContent(n, cards);
        const c = cards.find((x) => x.id === id) ?? card;
        return c ? cardContent(c) : "No such card.";
      }
      case "cards": {
        const vis = new Set(ctx.visible ?? []);
        return cards
          .slice(-60)
          .map((c) => `${c.id}: ${c.objectKind ? `${c.objectKind === "links" ? "reading" : c.objectKind} card, ` : ""}"${c.subject ?? c.selection ?? c.request ?? "a card"}"${vis.has(c.id) ? " (on screen)" : ""}${c.id === pointing.cardId ? (pick ? " (the one they picked)" : " (pointed at)") : ""}`)
          .concat(canvasNotes.slice(-40).map((n) => `${n.id}: note by ${n.by === "you" ? "them" : "you"}, "${n.text.replace(/\s+/g, " ").slice(0, 160)}"${vis.has(n.id) ? " (on screen)" : ""}${n.id === pointing.cardId ? " (pointed at)" : ""}`))
          .join("\n");
      }
      case "recent":
        return ctx.recent?.length ? ctx.recent.map((r) => `${Math.round(r.ago / 1000)}s ago: ${r.what}`).join("\n") : "Nothing recorded.";
      case "goals": {
        const goals = (state.goals ?? []).filter((g) => g.status === "open");
        return goals.length ? goals.map((g) => `${g.kind}: ${g.text}${g.cards.includes(pointing.cardId ?? "") ? " (the pointed card is under this)" : ""}`).join("\n") : "No goals yet.";
      }
      default:
        return `Unknown tool ${String(t.tool)}.`;
    }
  };
  type Action = { kind?: string; shape?: string; phrase?: string; find?: string; request?: string; ids?: unknown; marks?: unknown; text?: unknown };
  const llm = (await loadConfig()).llm;
  const convo: Message[] = [
    { role: "system", content: CALL },
    { role: "user", content: lines.join("\n\n") },
  ];
  const looked: string[] = [];
  let r: { say?: string; action?: Action; actions?: Action[]; look?: unknown } = {};
  let raw = "";
  for (let round = 0; round < 3; round++) {
    raw = await chat(llm, convo);
    r = {};
    const j0 = raw.indexOf("{");
    const j1 = raw.lastIndexOf("}");
    try {
      if (j0 >= 0 && j1 > j0) r = JSON.parse(raw.slice(j0, j1 + 1));
    } catch {}
    const looks = Array.isArray(r.look) ? (r.look as Record<string, unknown>[]).slice(0, 4) : [];
    if (!looks.length || r.say) break;
    const answers = looks.map((t) => {
      looked.push(`${t.tool}${t.id ? `(${t.id})` : ""}`);
      return `${t.tool}${t.id ? ` ${t.id}` : ""}:\n${tool(t)}`;
    });
    convo.push({ role: "assistant", content: raw });
    convo.push({ role: "user", content: `${answers.join("\n\n")}\n\n${round === 1 ? "Now answer: no more look-ups." : "Answer now, or look up something else if you must."}` });
  }
  if (looked.length) console.log(`call looked up: ${looked.join(", ")}`);
  if (!r.say && !r.actions && !r.action) {
    // Plain words, minus a template's brackets or a stray code fence.
    const plain = raw.replace(/```\w*|```/g, "").replace(/^\s*\[|\]\s*$/g, "").trim();
    r = { say: /^[{[]/.test(plain) ? "" : plain.slice(0, 600) };
  }
  let spoken = String(r.say ?? "").trim() || "Sorry, I didn't catch that. Could you say it again?";
  const actions = (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []).slice(0, 3);
  const done: string[] = [];
  const removed: string[] = [];
  let marks: Mark[] = [];
  let opened: string | undefined;
  let failed = false;
  // What didn't work, in words, to say and to log.
  const problems: string[] = [];
  const refs = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((x) => resolveRef(String(x), cards, canvasNotes));
  for (const a of actions) {
    try {
      if (a.kind === "grow" && card?.sem && pointing.key) {
        const shape = (EXTENSION_SHAPES as readonly string[]).includes(a.shape ?? "") ? (a.shape as ExtensionShape) : "aside";
        const ext: Extension = { id: newId(), at: pointing.key, shape, ask: text.slice(0, 500), status: "working" };
        await hooks.grow(card, ext);
        done.push(`grew ${shape} on ${pointing.key}`);
      } else if (a.kind === "descend" && card) {
        const phrase = (pointing.selection || a.phrase || "").trim().slice(0, 300);
        if (phrase) {
          await hooks.descend(card, phrase);
          done.push(`opened a card on "${phrase}"`);
        }
      } else if (a.kind === "find") {
        const what = (["set", "gallery", "videos", "links", "papers", "diagram", "notebook", "table", "plot", "graph", "map"] as const).find((k) => k === a.find) ?? "videos";
        const request = (a.request || pointing.selection || text).trim().slice(0, 300);
        const focus = card ? pointing.selection || (pointing.pieceText && pointing.pieceText.length <= 240 ? pointing.pieceText : undefined) : undefined;
        // Beside what they're pointing at, else beside the newest card.
        const made = await hooks.find(card ?? cards.at(-1), what, request, focus);
        done.push(`finding ${what}: ${request} (${made.id})`);
      } else if (a.kind === "open" && hooks.open) {
        let input = String(a.text ?? "").trim();
        // "text 2" (or "[text 2]") is what they typed into the call.
        const ref = input.match(/^\[?\s*text\s*(\d+)\s*\]?$/i);
        if (ref) input = ctx.sent?.find((t) => t.n === Number(ref[1]))?.text.trim() ?? "";
        if (!input && ctx.sent?.length === 1) input = ctx.sent[0].text.trim();
        if (input) {
          const made = await hooks.open(input.slice(0, 2000), card);
          opened = made.id;
          done.push(`opened ${made.what}`);
        } else problems.push("I couldn't tell what to open");
      } else if (a.kind === "relate" && hooks.relate) {
        const known = new Set(state.items.filter((i) => !i.hidden && (i.kind === "card" || i.kind === "image")).map((i) => i.id));
        let ids = (Array.isArray(a.ids) ? a.ids : []).map((x) => resolveRef(String(x), cards) ?? String(x)).filter((id) => known.has(id));
        // "These two": what they pointed at while saying it.
        if (ids.length < 2) ids = [...new Set([...ids, ...said.map((d) => d.p.cardId!).filter((id) => known.has(id))])];
        const made = ids.length >= 2 ? await hooks.relate(ids[0], ids[1]) : null;
        if (made) {
          opened = made.id;
          done.push(`related two things on a new card (${made.id})`);
        } else problems.push("I couldn't tell which two things to connect");
      } else if (a.kind === "note" && hooks.note) {
        const words = String(a.text ?? "").trim().slice(0, 2000);
        if (words) {
          const quote = pointing.selection || pointing.pieceText || pointing.figure;
          const about = card ?? note;
          await hooks.note(words, about ? { id: about.id, ...(pointing.key ? { key: pointing.key } : {}), ...(quote ? { quote } : {}) } : undefined);
          done.push(`left a note: ${words.slice(0, 80)}`);
        } else failed = true;
      } else if (a.kind === "mark") {
        const list = ((Array.isArray(a.marks) ? a.marks : []) as Record<string, unknown>[]).map((m): Record<string, unknown> => ({ ...m, card: resolveRef(String(m.card ?? ""), cards, canvasNotes) }));
        marks = list
          .filter((m) => m.card)
          .slice(0, 5)
          .map((m, i) => ({ n: i + 1, cardId: String(m.card), ...(m.piece ? { key: String(m.piece) } : {}), label: String(m.label ?? "").slice(0, 40) || `option ${i + 1}` }));
        if (marks.length) done.push(`numbered ${marks.length} on screen`);
      } else if (a.kind === "remove") {
        const asked = Array.isArray(a.ids) ? a.ids : typeof a.ids === "string" ? [a.ids] : [];
        const ids = [...new Set(refs(a.ids).filter((x): x is string => Boolean(x)))];
        if (ids.length) {
          const gone = await hooks.remove(ids);
          removed.push(...gone);
          done.push(`removed ${ids.length} card${ids.length > 1 ? "s" : ""}`);
        }
        if (ids.length < asked.length) problems.push(`I couldn't tell which card to take off${asked.length ? ` (${asked.map(String).join(", ")})` : ""}`);
      }
    } catch (err) {
      problems.push(`${a.kind ?? "something"} went wrong: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed) problems.push("something I tried on the canvas didn't work");
  if (problems.length) {
    console.warn(`call actions failed: ${problems.join("; ")} (actions: ${JSON.stringify(actions).slice(0, 600)})`);
    spoken += ` Though ${problems.join(", and ")}.`;
  }
  const did = done.length ? done.join("; ") : undefined;
  return { say: spoken, did, ...(removed.length ? { removed } : {}), ...(marks.length ? { marks } : {}), ...(looked.length ? { looked } : {}), ...(opened ? { opened } : {}) };
}

/** Where a new card for a phrase in `from` goes: to its right, below anything already there. */
export function besideOf(cards: CardItem[], from: CardItem, height: (c: CardItem) => number): { x: number; y: number } {
  const x = from.x + from.w + 64;
  let y = from.y;
  const column = cards.filter((c) => c.x < x + CARD_WIDTH && x < c.x + c.w);
  for (let moved = true; moved; ) {
    moved = false;
    for (const c of column) {
      const bottom = c.y + height(c);
      if (y < bottom + 24 && y + 900 > c.y - 24) {
        y = bottom + 24;
        moved = true;
      }
    }
  }
  return { x, y };
}
