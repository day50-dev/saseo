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
  /**
   * A page of a PDF: `asset` is that page alone as a PDF (drawn crisp, its text selectable), and the
   * image's own asset is its rendering (for boxes and the vision model).
   */
  pdf?: { asset: string; page: number; pages: number; url: string; title: string };
  /** The whole page read once, when something first needs it (relating two slides). */
  pageText?: string;
  topic?: string;
  /** A video on the canvas: played in place, and the asset is its thumbnail. */
  video?: VideoMeta;
  /** A moment stopped at in a video: this image is the frame, `transcript` what was said around it. */
  moment?: { videoImageId: string; videoId: string; t: number; title: string };
  transcript?: string;
}

/** How a copy's download is going, for the canvas to show while it waits. */
export interface CopyProgress {
  phase: "starting" | "video" | "sound" | "joining" | "ready" | "failed";
  /** 0 to 100, for the part being downloaded now. */
  percent?: number;
  bytes?: number;
  total?: number;
  /** Bytes a second. */
  speed?: number;
  /** Seconds left for the part being downloaded now. */
  eta?: number;
  error?: string;
}

/** How wide a video plays on the canvas, and how wide a moment's frame lands. */
export const VIDEO_WIDTH = 720;
export const MOMENT_WIDTH = 640;

export interface VideoMeta {
  videoId: string;
  title: string;
  channel: string;
  /** Seconds. */
  duration: number;
  /** False when the uploader doesn't allow playing it on other sites; then we play our own copy. */
  embeddable?: boolean;
  /** Our own copy of the video, for when it can't be embedded. */
  hosted?: "downloading" | "ready" | "failed";
  /** Why fetching the copy failed. */
  hostError?: string;
  /** Why we needed our own copy: the uploader disallows embedding, or the player refused it. */
  why?: "not-embeddable" | "player-refused";
}

/** What an update event may change: a card's fields, what was read off an image, or a note's words. */
export type ItemPatch = Partial<Omit<CardItem, "kind" | "id">> & Partial<Pick<ImageItem, "pageText" | "topic" | "video">> & Partial<Pick<NoteItem, "text" | "was" | "edited">>;

/**
 * A free-form note: words left on the canvas by the reader or the librarian, read as they are and
 * never explained. It remembers who left it, when, what it was about and what led to it, so it can
 * just sit there as a note or be looked into later ("why did I write this?").
 */
export interface NoteItem extends ItemState {
  kind: "note";
  id: string;
  text: string;
  by: "you" | "librarian";
  /** The person who left it (or asked the librarian to), on a shared canvas. */
  author?: Actor;
  /** When it was left. */
  at: string;
  x: number;
  y: number;
  w: number;
  /** Height as last drawn, recorded with moves. */
  h?: number;
  /** What it's about: a card or an image, a piece of a card, and the words there. Absent for a loose note. */
  on?: { id: string; key?: string; quote?: string };
  /** What led to it: where it was left from, what had just been said, and the log's seq at that moment. */
  context: { via: NoteVia; said?: string; seq: number };
  /** Its earlier wordings, oldest first: each with when it was written and by whom. */
  was?: { text: string; at: string; by: "you" | "librarian" }[];
  /** Who last reworded it, and when (absent until it's reworded). */
  edited?: { at: string; by: "you" | "librarian" };
}

export type NoteVia = "canvas" | "call" | "chat";

/** A note's story, for looking into it. */
export interface NoteHistory {
  /** Its wordings, oldest first, the current one last. */
  versions: { text: string; at: string; by: "you" | "librarian" }[];
  /** What happened on the canvas just before it was left, oldest first. */
  before: { at: string; what: string; id?: string }[];
  /** What happened to it, and to what it's about, since. */
  since: { at: string; what: string; id?: string }[];
}

/** How wide a new note is. */
export const NOTE_WIDTH = 340;

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
 * A shape grown from one piece of an explanation because the reader wanted more there (the
 * VizShapes vocabulary): an aside off to the side, a path down, numbered steps, a split into two
 * ways, a break-down into parts. Its own pieces can be extended in turn, so it grows as deep as
 * the reader takes it.
 */
export const EXTENSION_SHAPES = ["aside", "why", "then", "steps", "parts", "split", "example", "facts"] as const;
export type ExtensionShape = (typeof EXTENSION_SHAPES)[number];

export interface Extension {
  id: string;
  /** The piece it grows from: a Sem key ("why-1", "cat-why", "part-0") or an extension piece ("x3.1"). */
  at: string;
  shape: ExtensionShape;
  /** What the reader typed, when they asked in their own words (the model then chose the shape). */
  ask?: string;
  /** Words selected inside the piece: the extension is about those (a source connector's circle). */
  focus?: string;
  status: "working" | "done" | "failed";
  error?: string;
  /** The pieces: lines for asides, paths, steps and examples. */
  items?: string[];
  /** A heading per branch for a split ("The hard way", "The easy way"), then each branch's lines. */
  branches?: { label: string; items: string[] }[];
  /** For parts: each part, and what they add up to. */
  parts?: { name: string; note: string }[];
  together?: string;
  /** A short label drawn on the connector ("Two ways", "4 steps"), per the deck's Label shape. */
  label?: string;
  /** For a block of a restructured page: the paragraphs (in pageText) it carries. */
  from?: number[];
  /** When the ask was for a thing (videos, reading, a diagram…), not words: the card made for it. */
  made?: string;
}

/**
 * One section of a linked page, restructured without loss: its content regrouped into shapes
 * (blocks), every paragraph carried by some block, anything the model left out kept verbatim.
 */
export interface PageSection {
  title: string;
  /** Its paragraphs in pageText, first to last. */
  start: number;
  end: number;
  status: "working" | "done" | "failed";
  blocks?: Extension[];
  error?: string;
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

/** How far along a course sits; course codes aren't comparable across institutions, so this is the common scale. */
export const COURSE_LEVELS = ["intro undergraduate", "upper undergraduate", "graduate", "unknown"] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];

/** One sighting of a concept in a course, found while explaining it (see docs/BRAINSTORM.md, "Course level"). */
export interface CourseSighting {
  /** The concept's lookup key; `name` is how it was written. */
  concept: string;
  name: string;
  institution: string;
  /** The course code as the institution writes it: "MATH 54", "18.06", "Math 44A". */
  code: string;
  title: string;
  level: CourseLevel;
  /** Whether the course teaches the concept or assumes it. */
  role: "introduces" | "uses" | "unclear";
  url: string;
  quote: string;
  at: string;
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
  /** Who posted it (the YouTube channel): a university, a museum, a lecturer, or a hobbyist. */
  channel?: string;
}

/**
 * Things a conversation can make. Each lives on its own card, connected to the card it was asked
 * from, so a card gathers a collection of objects rather than a long transcript.
 */
/** A notebook cell, as in Jupyter: code to run, or markdown to read. */
export interface NotebookCell {
  id: string;
  kind: "code" | "markdown";
  source: string;
  /** What it showed when its author ran it (text, or a PNG as base64), kept from the original. */
  saved?: { text?: string; image?: string }[];
}

/** Where a notebook came from, when it was found rather than written. */
export interface NotebookSource {
  /** The notebook's page (GitHub, say). */
  url: string;
  /** "owner/repo: path", for crediting it. */
  title: string;
  /** Runs the original live on Binder (GitHub notebooks). */
  binder?: string;
}

/**
 * One tile of a card set: a person, a band, a work, a place, a video. Whatever can be checked is
 * from a real page (its picture, its one-line description, its link); `note` says why it's in the set.
 */
export interface SetEntry {
  title: string;
  /** Who or what it is, in a few words: "band, 1976–1982", "singer". */
  subtitle?: string;
  /** Why it's in this set. */
  note?: string;
  /** A picture: the article's thumbnail. */
  image?: string;
  /** The page it was checked against. */
  url?: string;
  /** The opening of that page, for a closer look. */
  extract?: string;
  /** No page could be found for it: it's the model's say-so, to be checked. */
  unverified?: boolean;
}

/** A picture in a gallery: kept as an asset, with what it shows and where it was found. */
export interface GalleryImage {
  asset: string;
  w: number;
  h: number;
  caption: string;
  /** A year or period, when the source says. */
  when?: string;
  /** The page it was found on, and that site's name. */
  page: string;
  site: string;
  /** Who made it and its license, when the source says (Commons does). */
  credit?: string;
}

export type CardObject =
  | { type: "set"; title: string; caption?: string; entries: SetEntry[] }
  | { type: "gallery"; title: string; caption?: string; images: GalleryImage[] }
  | { type: "notebook"; title: string; cells: NotebookCell[]; source?: NotebookSource; why?: string; language?: string }
  | { type: "videos"; videos: Video[] }
  | { type: "links"; links: FoundSource[] }
  | { type: "diagram"; svg: string; caption: string }
  | { type: "papers"; papers: Paper[] }
  | ({ type: "table" } & DataTable)
  | { type: "plot"; title: string; caption?: string; plot: Plot }
  | ({ type: "graph" } & NodeGraph)
  | ({ type: "map" } & PlaceMap);

// ---- Figures: data in a table, curves and points on axes, nodes and edges ----

/** A table of figures: empirical data, found on pages (credited), or from the model's memory (flagged). */
export interface DataTable {
  title: string;
  caption?: string;
  columns: string[];
  rows: (string | number | null)[][];
  sources: { title: string; url: string }[];
  /** No page held the figures: they're the model's recollection, to be checked. */
  fromMemory?: boolean;
  /** How it charts: the column along the bottom, the columns plotted, and how. */
  chart?: { x: number; y: number[]; kind: "line" | "bar" | "scatter" };
}

export interface PlotAxis {
  label?: string;
  min?: number;
  max?: number;
  log?: boolean;
}

/** One thing drawn on a plot: a function y = f(x), a curve (x(t), y(t)), or points. */
export interface PlotSeries {
  label?: string;
  /** y in terms of x, in plain math: "sin(x)/x", "x^2 - 3x + 1". */
  fn?: string;
  /** A curve in t, with t's range. */
  xt?: string;
  yt?: string;
  t?: [number, number];
  points?: [number, number][];
  /** Join the points with a line. */
  line?: boolean;
}

export interface Plot {
  x: PlotAxis;
  y: PlotAxis;
  series: PlotSeries[];
  /** Points called out with a label: a root, a maximum, an intersection. */
  marks?: { x: number; y: number; label: string }[];
  /** Keep x and y at the same scale (circles look round). */
  equal?: boolean;
}

/**
 * Places on a map. The model only names them; OpenStreetMap's geocoder says where they are, and
 * outlines come from its boundaries, so nothing on the map is the model's drawing.
 */
export interface PlaceMap {
  title: string;
  caption?: string;
  places: {
    name: string;
    lat: number;
    lon: number;
    note?: string;
    group?: string;
    /** The geocoder couldn't find it: placed where the model thought, to be checked. */
    approximate?: boolean;
  }[];
  /** Join the places in order: a route, a journey, a front line's advance. */
  route?: boolean;
  /** Countries or regions outlined, as GeoJSON geometry (today's borders). */
  areas?: { name: string; group?: string; geometry: unknown }[];
  /** Names the geocoder couldn't find at all. */
  missing?: string[];
}

/** Nodes and edges: a graph in the mathematical sense, or a network of how things connect. */
export interface NodeGraph {
  title: string;
  caption?: string;
  directed?: boolean;
  /** x and y (0 to 1, y down) give a standard drawing (the Petersen graph's star in a pentagon); else it's laid out. */
  nodes: { id: string; label: string; group?: string; note?: string; x?: number; y?: number }[];
  edges: { from: string; to: string; label?: string }[];
}

export type ObjectKind = CardObject["type"];

export type CardStage = "reading" | "asking" | "searching" | "writing" | "checking" | "done" | "failed";

/** A question the librarian asked the reader before explaining, and what they said. */
export interface Clarify {
  question: string;
  /** Likely answers, offered as buttons. */
  options: string[];
  /** What they answered; "" when they chose to skip. Absent while waiting. */
  answer?: string;
}

/** Something the reader told the librarian about themselves or their goal, kept for the canvas. */
export interface ReaderNote {
  q: string;
  a: string;
}

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
  /** What the learner asked about the two (RELATION_KINDS); none is "relates", the open question. */
  relKind?: RelationKind;
  /**
   * For a directed kind (leads, within): which of the two leads to the other, or is the part of the
   * other, as the librarian found it. None: neither does.
   */
  relFrom?: 0 | 1;
  /** Height as last drawn, recorded with moves. */
  h?: number;
  /**
   * A source card: a starting point that isn't an image. A page someone linked to (its readable
   * text is in pageText) or a statement or question they typed.
   */
  origin?: { kind: "page"; url: string; site?: string; title: string } | { kind: "note"; title: string };
  /** A conversation about this card, held at the card (principle 4), oldest first. */
  chat?: ChatMessage[];
  /** The librarian is answering the last message. */
  chatPending?: boolean;
  /** While the model writes: tokens received and milliseconds since it began. Shown live, never logged. */
  progress?: { tokens: number; ms: number };
  /** An object card: what was asked for, and once made, the object itself. */
  objectKind?: ObjectKind;
  request?: string;
  object?: CardObject;
  /** What it held before a message asked for something else (and what it was asked for), to bring back. */
  replaced?: { object: CardObject; request?: string; subject?: string };
  x: number;
  y: number;
  w: number;
  stage: CardStage;
  /** A question asked before explaining; the card waits at stage "asking" until it's answered. */
  clarify?: Clarify;
  /**
   * For a linked page: which paragraphs each piece of its shapes (sem) came from, by the piece's
   * key ("why-0", "what-0", "part-1", "together", "here-2") and paragraph number in pageText.
   */
  anchors?: Record<string, number[]>;
  /** For a linked page: its shapes are being drawn, or couldn't be. */
  shaping?: "working" | "failed" | "done";
  /**
   * For an explanation of something on an image: where on that image (`lookImage`) each piece
   * points, in the image's natural pixels, by piece key. Shown beside the piece, so "the diagram"
   * or "the second equation" is there to see.
   */
  looks?: Record<string, Rect>;
  /** Shapes the reader grew from pieces of the explanation, oldest first. */
  ext?: Extension[];
  /** For a linked page: the whole page, section by section, restructured into shapes without loss. */
  sections?: PageSection[];
  /** Explains a typed question: its last section is how it unfolds, not how a page uses it. */
  flow?: boolean;
  /** Where the card's subject has been seen taught (or assumed), from the course map. */
  taught?: CourseSighting[];
  lookImage?: string;
  looking?: "working" | "failed" | "done";
  /** The looks were snapped to the page's ink (older ones drifted along their line). */
  snapped?: boolean;
  /** The beginner search the explanation will use, kept so it can resume after a question. */
  searchQuery?: string;
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
  /** Tries made again by themselves after failing (up to RETRY_TRIES), and when the next one is due ("" when none is). */
  retries?: number;
  retryAt?: string;
}

/** How many times a failed card tries again by itself, waiting 2, 4, 8, 16, then 32 seconds. */
export const RETRY_TRIES = 5;
export const retryDelay = (n: number) => 2000 * 2 ** (n - 1);

export type Item = ImageItem | RegionItem | CardItem | NoteItem;

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
  | { type: "z"; order: { id: string; z: number }[] }
  /** A goal, as it now is (added, reworded, finished, cleared, or given another card). */
  | { type: "goal"; goal: Goal };

/**
 * What the learner is after, and what they had to go and find out on the way. Goals form a tree
 * over the cards: a card serves a goal; a subgoal is something a goal turned out to need; a
 * detour is curiosity off to the side. Goals change as the learner learns: rewording one keeps
 * what it was.
 */
export interface Goal {
  id: string;
  text: string;
  /** The goal this one serves; none for a goal of its own. */
  parentId?: string;
  kind: "goal" | "subgoal" | "detour";
  status: "open" | "done" | "dropped";
  /** The cards that work toward it, in the order they came. */
  cards: string[];
  /** Its earlier wordings, oldest first. */
  was?: string[];
  /** Who set it: the librarian's guess, or the learner. */
  by: "librarian" | "you";
  at: string;
}

export interface Move {
  id: string;
  x: number;
  y: number;
  /** A card's height as drawn when it was moved, so overlap above and below can be checked. */
  h?: number;
  /** A card's new width, when it was resized. */
  w?: number;
}

/** How narrow and how wide a card can be dragged. */
export const CARD_MIN_WIDTH = 280;
export const CARD_MAX_WIDTH = 4000;

/** Position is semantic: an explanation sits at least this far from what it explains, on any side, never on it. */
export const MIN_CHILD_GAP = 24;

/** A canvas: a name and a stable id, which is what its URL (/c/<id>) is built from. */
/** A page's text as paragraphs, numbered the same way on the server and in the browser. */
export const paragraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

export interface CanvasInfo {
  id: string;
  name: string;
  createdAt: string;
  /** Who it belongs to when accounts are on. Canvases from before accounts belong to the admins. */
  owner?: string;
  /** In the trash since then. Nothing in it is deleted; it can be restored. */
  trashedAt?: string;
  /** What the reader has told the librarian about their goal and background on this canvas. */
  reader?: ReaderNote[];
  /** The owner's name, as others see it. */
  ownerName?: string;
  /** People it's shared with, besides its owner. */
  members?: Member[];
  /** Links that let whoever has them join, as an editor or a viewer. Only the owner sees these. */
  links?: ShareLink[];
  /** How far into the log each person (by id) has looked: what came after is new to them. */
  seen?: Record<string, number>;
}

/** What someone can do on a canvas: everything (its owner), add and change things, or only look. */
export type Role = "owner" | "editor" | "viewer";

/** Someone a canvas is shared with. */
export interface Member {
  id: string;
  name: string;
  role: "editor" | "viewer";
  joinedAt: string;
}

/** A link that lets whoever has it join a canvas. */
export interface ShareLink {
  token: string;
  role: "editor" | "viewer";
  createdAt: string;
}

/** Who did something on a canvas: a person, or (later) an agent. */
export interface Actor {
  id: string;
  name: string;
}

/**
 * Something someone else did on a canvas since you last looked, per thing it touched: added it,
 * removed it, put it back, moved it, changed it (a note reworded, a card grown or asked about), or
 * a goal. `before` is where a moved thing was, so the move can be undone.
 */
export interface Change {
  id: string;
  what: "added" | "removed" | "restored" | "moved" | "changed" | "goal";
  by: Actor;
  at: string;
  /** The thing's name as the canvas shows it. */
  label: string;
  before?: { x: number; y: number };
}

/** A canvas as the list shows it: its name, plus what it holds and when it last changed. */
export interface CanvasSummary extends CanvasInfo {
  /** What you can do on it. */
  role: Role;
  updatedAt: string;
  cards: number;
  pages: number;
}

export interface LoggedEvent {
  seq: number;
  at: string;
  event: CanvasEvent;
  /** Who did it (or asked for the work that did it). Absent for the server's own work, and in old logs. */
  by?: Actor;
}

export interface CanvasState {
  seq: number;
  items: Item[];
  goals?: Goal[];
  /** When the last event was recorded. */
  updatedAt?: string;
}

/** New cards are laid out for landscape screens; any card's right edge drags it wider or narrower. */
export const CARD_WIDTH = 720;
/** A page read from a link is wider: it holds an article, not a diagram. */
export const SOURCE_WIDTH = 960;

// Sounds an open microphone hears that aren't anyone asking anything.
const FILLER = new Set(["a", "i", "o", "oh", "uh", "um", "umm", "uhm", "hmm", "hm", "mm", "mhm", "ah", "eh", "er", "huh", "the", "and", "so", "is", "it", "to", "of", "you", "thank", "thanks", "bye"]);

/**
 * Whether something heard on a call is worth answering: real words, not a stray "o" or "a",
 * a cough the recognizer turned into a syllable, or silence. One word counts if it's a word
 * that could be a question on its own ("why", "really", "eigenvectors").
 */
export function substantive(text: string): boolean {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => !FILLER.has(w));
  if (words.length >= 2) return true;
  return words.length === 1 && (words[0].length >= 3 || ["no", "ok", "go"].includes(words[0]));
}

// ---- Relations: what a connection between two things asks ----
// A connection carries meaning, and the meaning decides how it is drawn (a theme), never the reverse.

export const RELATION_KINDS = ["relates", "differs", "disputes", "leads", "within"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** The question each kind asks, as the reader chooses it when connecting two things. */
export const RELATION_ASK: Record<RelationKind, string> = {
  relates: "How are they related?",
  differs: "How are they different?",
  disputes: "Where do they disagree?",
  leads: "Does one lead to the other?",
  within: "Is one part of the other?",
};

/** Between the two names while the librarian works out the relation's own name. */
export const RELATION_MARK: Record<RelationKind, string> = { relates: "⟷", differs: "≠", disputes: "vs", leads: "→", within: "⊂" };

/** Kinds where one of the two comes first: it leads to the other, or is a part of it. */
export const DIRECTED: RelationKind[] = ["leads", "within"];

