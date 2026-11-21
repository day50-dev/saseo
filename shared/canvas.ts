// The canvas is an append-only log of events; its current state is the log replayed.
// Nothing is ever overwritten, and placed items never move.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageItem {
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
export interface RegionItem {
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

export interface FoundSource {
  n: number; // citation number used in the facets, [n]
  url: string;
  title: string;
  snippet: string;
  searcher: string;
}

export type CardStage = "reading" | "searching" | "writing" | "checking" | "done" | "failed";

export interface CardItem {
  kind: "card";
  id: string;
  /** The region or card this explains part of. */
  parentId: string;
  /** For a descent from another card: the words the learner selected there. */
  selection?: string;
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

export type Item = (ImageItem | RegionItem | CardItem) & {
  /** Set by a hide event. Hidden items stay in the log and can be shown again. */
  hidden?: boolean;
};

export type CanvasEvent =
  | { type: "add"; item: Item }
  | { type: "update"; id: string; patch: Partial<CardItem> }
  | { type: "hide"; ids: string[] }
  | { type: "show"; ids: string[] };

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
