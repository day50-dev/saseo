// A call with the librarian: you talk while pointing at things on the canvas, it answers aloud
// and changes the canvas as it goes (grows a piece, opens a deeper card). Speech runs on
// OpenAI-compatible servers you point it at: Kokoro for speaking, a /transcribe endpoint
// (faster-whisper) for listening. See docs/DESIGN.md, "A call with the librarian".
import { CARD_WIDTH, type CardItem, EXTENSION_SHAPES, type Extension, type ExtensionShape, type ObjectKind } from "../shared/canvas.ts";
import { type CanvasStore, getCanvasInfo, newId } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";

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
You can also change the canvas while you talk. Choose at most one action:
- "grow": add a shape to the piece they're pointing at. Shapes: aside (say more), why (reasons leading up to it), then
  (what follows), steps (how it's done), parts (break it down), split (two ways or cases), example (a worked example),
  facts (more facts). Use it when they ask for more about something on the canvas, or when a diagram would help more
  than talk. Then your words briefly say what you're adding ("Let me break that down for you on the card.").
- "descend": open a new card that explains a phrase (they selected it, or it's in the piece they point at). Use it when
  they ask what a term means and it deserves a full explanation.
- "find": put something new on the canvas: "videos" (lectures, explainers), "links" (reading: articles, notes,
  tutorials), "papers" (research papers on arXiv) or "diagram" (draw one). "request" says what, in a few words
  ("eigenvectors, visual intuition"). Use it whenever they ask you to find, pull up, show or get videos, reading,
  papers or a picture. Your words say what you're fetching ("I'll pull up some videos on eigenvectors.").
- "none": just talk.
Return JSON only: {"say": "...", "action": {"kind": "none" | "grow" | "descend" | "find", "shape": "...", "phrase": "...",
  "find": "videos" | "links" | "papers" | "diagram", "request": "..."}}`;

/** One turn of the call: what to say back, and what was done on the canvas. */
export async function callTurn(
  store: CanvasStore,
  text: string,
  pointing: Pointing,
  history: Turn[],
  hooks: {
    grow: (card: CardItem, ext: Extension) => Promise<void>;
    descend: (card: CardItem, phrase: string) => Promise<CardItem>;
    find: (near: CardItem | undefined, kind: ObjectKind, request: string) => Promise<CardItem>;
  },
): Promise<{ say: string; did?: string }> {
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
    `On the canvas: ${cards.map((c) => c.subject ?? c.selection ?? "a card").slice(0, 30).join("; ")}`,
    notes.length ? `What they've told you about themselves: ${notes.join("; ")}` : "",
    card ? `They are pointing at the card "${card.subject ?? card.selection}":\n${semText(card)}` : "They aren't pointing at anything.",
    pointing.pieceText ? `Specifically this piece of it: "${pointing.pieceText}"` : "",
    pointing.selection
      ? `They have SELECTED these words (this is what "this" means): "${pointing.selection}"${pointing.selectionContext ? `\nThey sit in: "${pointing.selectionContext}"` : ""}`
      : "",
    history.length ? `The call so far:\n${history.slice(-8).map((t) => `${t.role === "you" ? "Reader" : "You"}: ${t.text}`).join("\n")}` : "",
    `They just said: "${text}"`,
  ].filter(Boolean);
  const r = await chatJson<{ say?: string; action?: { kind?: string; shape?: string; phrase?: string; find?: string; request?: string } }>((await loadConfig()).llm, [
    { role: "system", content: CALL },
    { role: "user", content: lines.join("\n\n") },
  ]);
  let spoken = String(r.say ?? "").trim() || "Sorry, I didn't catch that. Could you say it again?";
  let did: string | undefined;
  const kind = r.action?.kind;
  try {
    if (kind === "grow" && card?.sem && pointing.key) {
      const shape = (EXTENSION_SHAPES as readonly string[]).includes(r.action?.shape ?? "") ? (r.action!.shape as ExtensionShape) : "aside";
      const ext: Extension = { id: newId(), at: pointing.key, shape, ask: text.slice(0, 500), status: "working" };
      await hooks.grow(card, ext);
      did = `grew ${shape} on ${pointing.key}`;
    } else if (kind === "find") {
      const what = (["videos", "links", "papers", "diagram"] as const).find((k) => k === r.action?.find) ?? "videos";
      const request = (r.action?.request || pointing.selection || text).trim().slice(0, 300);
      // Beside what they're pointing at, else beside the newest card.
      const made = await hooks.find(card ?? cards.at(-1), what, request);
      did = `finding ${what}: ${request} (${made.id})`;
    } else if (kind === "descend" && card) {
      const phrase = (pointing.selection || r.action?.phrase || "").trim().slice(0, 300);
      if (phrase) {
        await hooks.descend(card, phrase);
        did = `opened a card on "${phrase}"`;
      }
    }
  } catch {
    spoken += " I couldn't change the canvas just now, though.";
  }
  return { say: spoken, did };
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
