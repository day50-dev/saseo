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
  /** Stacking order among images and cards; higher draws on top. Unset means 0. */
  z?: number;
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
  /** Provenance, for a page added from arXiv. */
  source?: ImageSource;
  /** The whole page read once, when something first needs it (relating two slides). */
  pageText?: string;
  topic?: string;
}

/** What an update event may change: a card's fields, or what was read off an image. */
export type ItemPatch = Partial<Omit<CardItem, "kind" | "id">> & Partial<Pick<ImageItem, "pageText" | "topic">>;

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
  /** Terms of art the explanation itself uses, as written: drawn so they read as strict terms. */
  terms?: string[];
  /** Everyday phrases standing in for a real term ("an invisible push" for "magnetic field"). */
  standIns?: { phrase: string; concept: string }[];
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

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** When the message made something, the card that holds it. */
  objectId?: string;
}

/** An arXiv paper, as found by search or looked up by id. */
export interface Paper {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  category: string;
  url: string;
}

/** Where an image came from, when it wasn't dropped in by hand. */
export interface ImageSource {
  kind: "arxiv";
  id: string;
  title: string;
  page: number;
  url: string;
}

export interface Video {
  url: string;
  videoId: string;
  title: string;
  snippet: string;
}

/**
 * Things a conversation can make. Each lives on its own card, connected to the card it was asked
 * from, so a card gathers a collection of objects rather than a long transcript.
 */
export type CardObject =
  | { type: "videos"; videos: Video[] }
  | { type: "links"; links: FoundSource[] }
  | { type: "diagram"; svg: string; caption: string }
  | { type: "papers"; papers: Paper[] };

export type ObjectKind = CardObject["type"];

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
  /** For a box on a page: the whole page's text, so every later step knows the context. */
  pageText?: string;
  /** For a box on a page: the phrases in it whose register an outsider could misjudge. */
  terms?: RegisterNote[];
  /**
   * A relation card: the learner asked how two things relate, and this explains it. Either may be
   * a card or a whole image. `parentId` is the first of the two; the card depends on both.
   */
  relates?: [string, string];
  /** Height as last drawn, recorded with moves. */
  h?: number;
  /** A conversation about this card, held at the card (principle 4), oldest first. */
  chat?: ChatMessage[];
  /** The librarian is answering the last message. */
  chatPending?: boolean;
  /** An object card: what was asked for, and once made, the object itself. */
  objectKind?: ObjectKind;
  request?: string;
  object?: CardObject;
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
  | { type: "update"; id: string; patch: ItemPatch }
  | { type: "hide"; ids: string[] }
  | { type: "show"; ids: string[] }
  /** The learner moved things. The system itself never moves anything. */
  | { type: "move"; moves: Move[] }
  | { type: "collapse"; ids: string[]; collapsed: boolean }
  | { type: "chat"; id: string; message: ChatMessage }
  /** The learner restacked things: front, back, forward, backward. */
  | { type: "z"; order: { id: string; z: number }[] };

export interface Move {
  id: string;
  x: number;
  y: number;
  /** A card's height as drawn when it was moved, so overlap above and below can be checked. */
  h?: number;
}

/** Position is semantic: an explanation sits at least this far from what it explains, on any side, never on it. */
export const MIN_CHILD_GAP = 24;

/** A canvas: a name and a stable id, which is what its URL (/c/<id>) is built from. */
export interface CanvasInfo {
  id: string;
  name: string;
  createdAt: string;
  /** Who it belongs to when accounts are on. Canvases from before accounts belong to the admins. */
  owner?: string;
}

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
