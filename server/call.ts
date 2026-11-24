// A call with the librarian: you talk while pointing at things on the canvas, it answers aloud
// and changes the canvas as it goes (grows a piece, opens a deeper card). Speech runs on
// OpenAI-compatible servers you point it at: Kokoro for speaking, a /transcribe endpoint
// (faster-whisper) for listening. See docs/DESIGN.md, "A call with the librarian".
import { CARD_WIDTH, type CardItem, EXTENSION_SHAPES, type Extension, type ExtensionShape, type ObjectKind } from "../shared/canvas.ts";
import { type CanvasStore, getCanvasInfo, newId } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chat } from "./llm.ts";

export const SPEECH = {
  tts: process.env.LIBRARIAN_TTS_URL ?? "",
  stt: process.env.LIBRARIAN_STT_URL ?? "",
  voice: process.env.LIBRARIAN_VOICE ?? "af_heart",
};

export const speechOn = () => Boolean(SPEECH.tts && SPEECH.stt);

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

/** Words in, speech out (wav). */
export async function say(text: string): Promise<ArrayBuffer> {
  const r = await fetch(`${SPEECH.tts.replace(/\/$/, "")}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: text, voice: SPEECH.voice, response_format: "wav" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`speech: HTTP ${r.status}`);
  return r.arrayBuffer();
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
}

export interface Turn {
  role: "you" | "librarian";
  text: string;
}

const CALL = `You are a research librarian on a voice call with a curious, intelligent reader who is not a specialist.
They are looking at a canvas of explanations drawn as diagrams, and they can point at a piece of one while they talk.
Answer the way you'd talk on the phone: warm, plain, short. One to three sentences, no lists, no markdown, no citations,
no LaTeX (say math in words: "A sub j", "the integral of"). Descend: explain with ideas more familiar than what they ask about.
When they say "this", "this part", "right here", "that bit" or "here", they mean the words they have selected, if any;
otherwise the piece they are pointing at. Speak to exactly that: say briefly which part you're taking up, then help with it.
You can also change the canvas while you talk, with up to three actions:
- {"kind": "grow", "shape": "..."}: add a shape to the piece they're pointing at. Shapes: aside (say more), why
  (reasons leading up to it), then (what follows), steps (how it's done), parts (break it down), split (two ways or
  cases), example (a worked example), facts (more facts). Use it when they ask for more about something on the
  canvas, or when a diagram would help more than talk.
- {"kind": "descend", "phrase": "..."}: open a new card that explains a phrase (they selected it, or it's in the piece
  they point at). Use it when they ask what a term means and it deserves a full explanation.
- {"kind": "find", "find": "videos" | "links" | "papers" | "diagram" | "notebook" | "table" | "plot" | "graph", "request": "..."}: put something
  new on the canvas: videos (lectures, explainers), links (reading), papers (arXiv), diagram (draw one), notebook
  (a runnable example in a Jupyter notebook, found online; it opens beside the canvas), table (figures and data, read
  off real pages), plot (functions, curves or data on x-y axes) or graph (nodes and edges: graph theory, a network). "request" says what, in a few
  words. Use it whenever they ask you to find, pull up, show or get videos, reading, papers, a picture, an example, data, a plot or a graph.
- {"kind": "remove", "ids": ["..."]}: take cards off the canvas (they can undo it). Use the ids from the list of
  cards on the canvas: the ones they point at, name or describe ("those two diagrams", "the sketches"). Only cards
  they clearly mean.
Your words say briefly what you're doing ("Let me break that down on the card.", "I'll take those two off.").
NEVER say you did, are doing or will do anything to the canvas that isn't one of your actions this turn: if they ask
for something you can't do (move or resize things, for instance), say so plainly.
Return JSON only: {"say": "...", "actions": [{"kind": "grow" | "descend" | "find" | "remove", ...}]} (actions may be [])`;

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
  },
): Promise<{ say: string; did?: string; removed?: string[] }> {
  const { items } = await store.getState();
  const cards = items.filter((i): i is CardItem => i.kind === "card" && !i.hidden);
  const card = pointing.cardId ? cards.find((c) => c.id === pointing.cardId) : undefined;
  const info = await getCanvasInfo(store.id);
  const notes = (info?.reader ?? []).map((n) => n.a).filter(Boolean);
  const semText = (c: CardItem) =>
    c.sem
      ? [
          `Why: ${c.sem.why.join(" ")}`,
          `What: ${[c.sem.what.gist, ...c.sem.what.details].join(" ")}`,
          c.sem.parts.length ? `Parts: ${c.sem.parts.map((p) => `${p.symbol} = ${p.meaning}`).join("; ")}` : "",
          c.sem.here.length ? `Then: ${c.sem.here.join(" ")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : (c.pageText ?? "").slice(0, 2000);
  const lines = [
    `Cards on the canvas, oldest first (id: what it is):\n${cards
      .slice(-40)
      .map((c) => `${c.id}: ${c.objectKind ? `${c.objectKind === "links" ? "reading" : c.objectKind} card, ` : ""}${c.subject ?? c.selection ?? c.request ?? "a card"}${c.id === pointing.cardId ? " (pointed at)" : ""}`)
      .join("\n")}`,
    notes.length ? `What they've told you about themselves: ${notes.join("; ")}` : "",
    card ? `They are pointing at the card "${card.subject ?? card.selection}":\n${semText(card)}` : "They aren't pointing at anything.",
    pointing.pieceText ? `Specifically this piece of it: "${pointing.pieceText}"` : "",
    pointing.selection
      ? `They have SELECTED these words (this is what "this" means): "${pointing.selection}"${pointing.selectionContext ? `\nThey sit in: "${pointing.selectionContext}"` : ""}`
      : "",
    history.length ? `The call so far:\n${history.slice(-8).map((t) => `${t.role === "you" ? "Reader" : "You"}: ${t.text}`).join("\n")}` : "",
    `They just said: "${text}"`,
  ].filter(Boolean);
  type Action = { kind?: string; shape?: string; phrase?: string; find?: string; request?: string; ids?: unknown };
  // A reply that isn't JSON is still a reply: it's said as it is (never an error read aloud, which
  // the microphone would hear and answer, round and round).
  const raw = await chat((await loadConfig()).llm, [
    { role: "system", content: CALL },
    { role: "user", content: lines.join("\n\n") },
  ]);
  let r: { say?: string; action?: Action; actions?: Action[] } = {};
  const j0 = raw.indexOf("{");
  const j1 = raw.lastIndexOf("}");
  try {
    if (j0 >= 0 && j1 > j0) r = JSON.parse(raw.slice(j0, j1 + 1));
  } catch {}
  if (!r.say && !r.actions && !r.action) {
    // Plain words, minus a template's brackets or a stray code fence.
    const plain = raw.replace(/```\w*|```/g, "").replace(/^\s*\[|\]\s*$/g, "").trim();
    r = { say: /^[{[]/.test(plain) ? "" : plain.slice(0, 600) };
  }
  let spoken = String(r.say ?? "").trim() || "Sorry, I didn't catch that. Could you say it again?";
  const actions = (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []).slice(0, 3);
  const done: string[] = [];
  const removed: string[] = [];
  let failed = false;
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
        const what = (["videos", "links", "papers", "diagram", "notebook", "table", "plot", "graph"] as const).find((k) => k === a.find) ?? "videos";
        const request = (a.request || pointing.selection || text).trim().slice(0, 300);
        const focus = card ? pointing.selection || (pointing.pieceText && pointing.pieceText.length <= 240 ? pointing.pieceText : undefined) : undefined;
        // Beside what they're pointing at, else beside the newest card.
        const made = await hooks.find(card ?? cards.at(-1), what, request, focus);
        done.push(`finding ${what}: ${request} (${made.id})`);
      } else if (a.kind === "remove") {
        const known = new Set(cards.map((c) => c.id));
        const ids = (Array.isArray(a.ids) ? a.ids : []).map(String).filter((id) => known.has(id));
        if (ids.length) {
          const gone = await hooks.remove(ids);
          removed.push(...gone);
          done.push(`removed ${ids.length} card${ids.length > 1 ? "s" : ""}`);
        } else failed = true;
      }
    } catch {
      failed = true;
    }
  }
  if (failed) spoken += " Something I tried on the canvas didn't work, though.";
  const did = done.length ? done.join("; ") : undefined;
  return { say: spoken, did, ...(removed.length ? { removed } : {}) };
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
