// The canvas is an append-only log of events; its current state is the log replayed.
// Nothing is ever overwritten, and placed items never move.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** State every item can carry, set by events. */
interface ItemState {
  /** Set by a hide event. Hidden items stay in the log and can be shown again. */
  hidden?: boolean;
  /** Folded: an image or card shows only its title, and everything below it is out of view. */
  collapsed?: boolean;
}

export interface ImageItem extends ItemState {
  kind: "image";
  id: string;
  asset: string; // file name under the assets endpoint
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  naturalW: number;
  naturalH: number;
}

/** A rectangle the learner drew on an image; `rect` is in the image's natural pixels. */
export interface RegionItem extends ItemState {
  kind: "region";
  id: string;
  imageId: string;
  rect: Rect;
}

export interface Facets {
  why: string;
  what: string;
  how: string;
  name: string;
}

/**
 * An explanation as meaning, not layout (principle 5). Each field maps to a semshape:
 * why/here are Paths (a chain where each step follows from the last), what is a Category
 * with Descriptions, parts are a horizontal bus joined by a Y-connector into `together`,
 * and name is an Aside. Text may cite found sources as [n].
 */
export interface Sem {
  why: string[];
  what: { gist: string; details: string[] };
  parts: { symbol: string; meaning: string; note: string }[];
  together: string;
  here: string[];
  name: string;
}

/**
 * Principle 9: the same English words can be a strict term of art or casual description, and
 * an outsider can't tell which. Every phrase the librarian explains or flags carries its register.
 */
export type Register = "term" | "idiom" | "casual" | "notation";

export const REGISTERS: Record<Register, { label: string; gloss: string }> = {
  term: { label: "Term of art", gloss: "a technical term with a strict definition" },
  idiom: { label: "Idiom", gloss: "a standard move or phrase insiders use, with a precise meaning that's rarely spelled out" },
  casual: { label: "Informal", gloss: "everyday language the author is using loosely" },
  notation: { label: "Loosened notation", gloss: "a symbol used roughly, meaning 'morally this, details skipped'" },
};

export interface RegisterNote {
  text: string;
  register: Register;
  /** For informal language and loosened notation: what is actually meant. For a term: a short gloss. */
  means: string;
  /** Where a term of art comes from, when it was borrowed from another field. */
  field?: string;
}

export interface FoundSource {
  n: number; // citation number used in the facets, [n]
  url: string;
  title: string;
  snippet: string;
  searcher: string;
}

export type CardStage = "reading" | "searching" | "writing" | "checking" | "done" | "failed";

export interface CardItem extends ItemState {
  kind: "card";
  id: string;
  /** The region or card this explains part of. */
  parentId: string;
  /** For a descent from another card: the words the learner selected there. */
  selection?: string;
  /** The sentence or line those words sat in, which says what they refer to. */
  context?: string;
  /** For a descent: whether the selected words were a strict term, an idiom, casual, or notation. */
  register?: RegisterNote;
  x: number;
  y: number;
  w: number;
  stage: CardStage;
  subject?: string;
  transcription?: string;
  topic?: string;
  /** Older cards: plain paragraphs. Newer cards carry `sem` instead. */
  facets?: Facets;
  sem?: Sem;
  sources?: FoundSource[];
  /** Probability from the System One check that the explanation climbs (0 = clearly descends). */
  climb?: number;
  rewritten?: boolean;
  error?: string;
}

export type Item = ImageItem | RegionItem | CardItem;

export type CanvasEvent =
  | { type: "add"; item: Item }
  | { type: "update"; id: string; patch: Partial<CardItem> }
  | { type: "hide"; ids: string[] }
  | { type: "show"; ids: string[] }
  /** The learner moved things. The system itself never moves anything. */
  | { type: "move"; moves: Move[] }
  | { type: "collapse"; ids: string[]; collapsed: boolean };

export interface Move {
  id: string;
  x: number;
  y: number;
}

/** Position is semantic: an explanation stays at least this far right of what it explains. */
export const MIN_CHILD_GAP = 24;

export interface LoggedEvent {
  seq: number;
  at: string;
  event: CanvasEvent;
}

export interface CanvasState {
  seq: number;
  items: Item[];
}

export const CARD_WIDTH = 480;
