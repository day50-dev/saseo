import { GoalsPanel } from "./GoalsPanel.tsx";
import { Logo } from "./Logo.tsx";
import { ChangesPanel, colourFor, names, ShareDialog } from "./Sharing.tsx";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CARD_MAX_WIDTH, CARD_MIN_WIDTH, CARD_WIDTH, type CanvasSummary, type Change, type Member, type Role, type ShareLink, type CardItem, type CardStage, type Extension, type Goal, type ImageItem, type Item, MIN_CHILD_GAP, NOTE_WIDTH, type NoteItem, type Paper, RELATION_ASK, RELATION_KINDS, type RelationKind, DIRECTED, type Rect, type RegionItem, VIDEO_MAX_WIDTH, VIDEO_MIN_WIDTH, VIDEO_WIDTH } from "../shared/canvas.ts";
import { Note } from "./Note.tsx";
import { Card, type Side } from "./Card.tsx";
import { STOP_BAR, VideoPlayer } from "./VideoPlayer.tsx";
import { PAGER_BAR, PdfReader } from "./PdfReader.tsx";
import { players } from "./youtube.ts";
import { assetUrl, CanvasNotFound, canvasApi, canvasesApi } from "./canvasApi.ts";
import { renderPages as renderPaperPages } from "./arxiv.ts";
import { ArxivPanel } from "./ArxivPanel.tsx";
import { EXAMPLES, type Example, exampleByKey, runExample } from "./examples.ts";
import { ago } from "./Home.tsx";
import { linkTo, navigate } from "./router.ts";
import { useIsAdmin, useIsAnonymous, useMe } from "./session.ts";
import { CallBar, canCallWith } from "./Call.tsx";
import { NotebookPanel } from "./NotebookPanel.tsx";
import { PdfPage } from "./PdfPage.tsx";

interface View {
  x: number;
  y: number;
  scale: number;
}

const GAP = 64; // horizontal gap between a source and its explanations
const STACK_GAP = 24; // vertical gap between cards in one column
const GRIP = 30; // screen pixels above an image taken by its grip
const PENDING_HEIGHT = 900; // space reserved for a card that hasn't been written yet; diagram cards run 700-1100px
const MAX_IMAGE_WIDTH = 900;

/** Where a canvas opens: full size on a desk, zoomed so a card fits across on a phone. */
function defaultView(): View {
  const w = window.innerWidth;
  if (w >= 700) return { x: 40, y: 80, scale: 1 };
  return { x: 10, y: 16, scale: Math.max(0.4, Math.min(1, (w - 20) / CARD_WIDTH)) };
}

// Where you were looking is remembered per canvas, in this browser only.
function loadView(canvasId: string): View {
  try {
    const v = JSON.parse(localStorage.getItem(`librarian.view.${canvasId}`) ?? "");
    if (typeof v?.x === "number" && typeof v?.scale === "number") return v;
  } catch {}
  return defaultView();
}

function saveView(canvasId: string, v: View) {
  try {
    localStorage.setItem(`librarian.view.${canvasId}`, JSON.stringify(v));
  } catch {}
}

const isPending = (c: CardItem) => c.stage !== "done" && c.stage !== "failed";

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Which side of its source a card sits on. Its branch keeps growing that way. */
type Dir = "left" | "right" | "above" | "below";

type Mode = "select" | "pan";

interface Pending {
  key: string;
  x: number;
  y: number;
  /** The words being explained; empty for a box drawn on an image. */
  label: string;
  /** What the placeholder says, when it isn't explaining words. */
  text?: string;
  parentId?: string;
  box?: { x: number; y: number; w: number; h: number };
}

const NONE: string[] = [];
const NO_STAGES: Record<string, CardStage> = {};

function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

type Restack = "front" | "back" | "forward" | "backward";

function loadMode(): Mode {
  try {
    return localStorage.getItem("librarian.mode") === "pan" ? "pan" : "select";
  } catch {
    return "select";
  }
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function Canvas({ canvasId }: { canvasId: string }) {
  const admin = useIsAdmin();
  const anonymous = useIsAnonymous();
  const me = useMe();
  const canCall = canCallWith(me.speech);
  const [calling, setCalling] = useState(false);
  // The notebook open beside the canvas, and whether to run it (one just asked for).
  const [notebook, setNotebook] = useState<{ id: string; autoRun: boolean } | null>(null);
  const seenNotebooks = useRef<Set<string> | null>(null);
  // Words selected on a PDF page, waiting for "Explain".
  const [pdfSel, setPdfSel] = useState<{ imageId: string; text: string; rect: DOMRect } | null>(null);
  useEffect(() => {
    // Gone when the selection is.
    const change = () => {
      if (window.getSelection()?.isCollapsed ?? true) setPdfSel(null);
    };
    document.addEventListener("selectionchange", change);
    return () => document.removeEventListener("selectionchange", change);
  }, []);
  const api = useMemo(() => canvasApi(canvasId), [canvasId]);
  const [name, setName] = useState("");
  const [trashedAt, setTrashedAt] = useState<string | undefined>();
  // Sharing: what you can do here, who else is on it, and (for its owner) the links to it.
  const [role, setRole] = useState<Role>("owner");
  const [members, setMembers] = useState<Member[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [seq, setSeq] = useState(0);
  // What others did since you last looked: still to go through, and whether the list is open.
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [latestSeen, setLatestSeen] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const viewOnly = role === "viewer";
  const [notFound, setNotFound] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => loadView(canvasId));
  const [draft, setDraft] = useState<{ imageId: string; start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  // A container being dragged, with everything that hangs off it.
  // A connection being dragged from one card's port, to ask how it relates to another card.
  const [link, setLink] = useState<{ from: string; side: Side; start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  // A connection just dropped on another card: what to ask about the two, chosen from a menu there.
  const [relAsk, setRelAsk] = useState<{ a: string; b: string; x: number; y: number; left: number; top: number; line: { start: { x: number; y: number }; end: { x: number; y: number } } } | null>(null);
  const [drag, setDrag] = useState<{
    ids: string[];
    start: { x: number; y: number };
    orig: Record<string, { x: number; y: number }>;
    /** The source the dragged card must stay off, grown by the gap, and the card's own size. */
    avoid: { box: Box; w: number; h: number; x0: number; y0: number } | null;
    dx: number;
    dy: number;
  } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // The image or card the stacking buttons act on.
  const [selected, setSelected] = useState<string | null>(null);
  // Several things chosen at once by Shift-dragging a box round them, to delete together.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  // The card whose border a tap has readied for resizing by touch; picking anything else unreadies it.
  const [resizeArmed, setResizeArmed] = useState<string | null>(null);
  useEffect(() => {
    if (resizeArmed && selected !== resizeArmed) setResizeArmed(null);
  }, [selected, resizeArmed]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalsOpen, setGoalsOpen] = useState(() => {
    try {
      return localStorage.getItem("librarian.goalsOpen") === "1";
    } catch {
      return false;
    }
  });
  const [goalLit, setGoalLit] = useState<Set<string>>(new Set());
  const [dockOpen, setDockOpen] = useState(false);
  // A piece's picture is hovered: outline where it is on its image.
  const [peek, setPeek] = useState<{ imageId: string; rect: Rect } | null>(null);
  // Explanations asked for but not on the canvas yet: a placeholder shows where each will land,
  // so a selection is answered at once rather than after the server replies.
  const [expected, setExpected] = useState<Pending[]>([]);
  const [heights, setHeights] = useState<Record<string, number>>({});
  // A note being written, not yet saved: where it goes and what it's about.
  const [noteDraft, setNoteDraft] = useState<{ x: number; y: number; on?: { id: string } } | null>(null);
  const startNoteRef = useRef<() => void>(() => {});
  // Something to bring into view once it has loaded (opened on a call).
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRefs = useRef<Record<string, HTMLImageElement | null>>({});
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [mode, setMode] = useState<Mode>(loadMode);
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Holding Space pans temporarily, whatever the mode.
  const panning = mode === "pan" || spaceHeld;

  useEffect(() => {
    try {
      localStorage.setItem("librarian.mode", mode);
    } catch {}
  }, [mode]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        setSpaceHeld(true);
      } else if (e.key === "v" || e.key === "V") setMode("select");
      else if (e.key === "h" || e.key === "H") setMode("pan");
      else if (e.key === "/") {
        e.preventDefault();
        setDockOpen(true);
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        startNoteRef.current();
      }
    };
    const up = (e: KeyboardEvent) => e.key === " " && setSpaceHeld(false);
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      setName(s.name);
      setTrashedAt(s.trashedAt);
      setRole(s.role ?? "owner");
      setMembers(s.members ?? []);
      setLinks(s.links ?? []);
      setSeq(s.seq);
      // Hidden items stay in the log (undo can bring them back) but aren't drawn or laid out around.
      setItems(s.items.filter((i) => !i.hidden));
      setGoals(s.goals ?? []);
      setLoaded(true);
    } catch (e) {
      if (e instanceof CanvasNotFound) setNotFound(true);
      else setError(String(e));
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll only while some card is still being written.
  const pending = items.some(
    (i) =>
      (i.kind === "image" && i.video?.hosted === "downloading") ||
      (i.kind === "card" &&
      (isPending(i) ||
        i.chatPending ||
        i.shaping === "working" ||
        i.looking === "working" ||
        Boolean(i.ext?.some((e) => e.status === "working")) ||
        Boolean(i.sections?.some((sec) => sec.status === "working")) ||
        // Still waiting to hear where its subject is taught.
        (i.stage === "done" && Boolean(i.sem) && !i.taught && !i.relates && !i.objectKind))),
  );
  // While a diagram is being drawn, poll fast enough to watch it appear.
  const drawing = items.some((i) => i.kind === "card" && i.objectKind === "diagram" && isPending(i));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refresh, drawing ? 350 : 1000);
    return () => clearInterval(t);
  }, [pending, drawing, refresh]);
  // A shared canvas can change under you: look for others' changes every few seconds.
  const shared = role !== "owner" || members.length > 0;
  useEffect(() => {
    if (!shared || pending) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [shared, pending, refresh]);

  // Coming back: what others did since you last looked.
  useEffect(() => {
    api.since().then((r) => {
      setChanges(r.changes);
      setLatestSeen(r.latest);
    }, () => setChanges([]));
  }, [api]);
  // With nothing left to go through, what's here now counts as seen (a few seconds at a time).
  const seenSent = useRef(0);
  useEffect(() => {
    if (changes === null || changes.length > 0 || seq <= seenSent.current) return;
    const t = setTimeout(() => {
      seenSent.current = seq;
      void api.seen(seq).catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
  }, [changes, seq, api]);
  const keepChange = (c: Change) => setChanges((all) => (all ?? []).filter((x) => x !== c));
  const undoChange = async (c: Change) => {
    try {
      if (c.what === "added") await api.hide([c.id]);
      else if (c.what === "removed") await api.show([c.id]);
      else if (c.what === "moved" && c.before) await api.move([{ id: c.id, x: c.before.x, y: c.before.y }]);
      keepChange(c);
      await refresh();
    } catch (e) {
      setError(`Couldn't undo that: ${e}`);
    }
  };
  const doneReviewing = () => {
    setReviewing(false);
    setChanges([]);
    void api.seen(Math.max(latestSeen, seq)).catch(() => {});
  };

  useEffect(() => saveView(canvasId, view), [canvasId, view]);

  useEffect(() => {
    document.title = name ? `${name} · Saseo` : "Saseo";
  }, [name]);

  const rename = async (next: string) => {
    const clean = next.trim();
    if (!clean || clean === name) return;
    setName(clean);
    try {
      setName((await canvasesApi.rename(canvasId, clean)).name);
    } catch (e) {
      setError(`Couldn't rename: ${e}`);
    }
  };

  // ---- Undo and redo ----
  // Every step is reversible because removal only hides. A new step after an undo starts a new
  // branch; the steps it replaced are still in the log.

  interface Step {
    label: string;
    undo: () => Promise<unknown>;
    redo: () => Promise<unknown>;
  }
  const undoStack = useRef<Step[]>([]);
  const redoStack = useRef<Step[]>([]);
  const [, setStackVersion] = useState(0);
  const bump = () => setStackVersion((n) => n + 1);

  const pushStep = (step: Step) => {
    undoStack.current.push(step);
    redoStack.current = [];
    bump();
  };

  /** Records that `ids` were just added; undo hides them and whatever hangs off them. */
  const added = (label: string, ids: string[]) => {
    let hiddenIds: string[] = ids;
    pushStep({
      label,
      undo: async () => {
        hiddenIds = (await api.hide(ids)).ids;
      },
      redo: () => api.show(hiddenIds),
    });
  };

  /** Saying more on a card: undo takes it away (with what grew from it), redo puts back what was taken. */
  const grewStep = (cardId: string, extId: string) => {
    let taken: Extension[] = [];
    pushStep({
      label: "say more",
      undo: async () => {
        taken = (await api.unextend(cardId, extId)).taken;
      },
      redo: () => api.restoreExt(cardId, taken),
    });
  };
  /** Taking a grown shape away: undo puts it back. */
  const ungrewStep = (cardId: string, extId: string, taken: Extension[]) => {
    if (!taken.length) return;
    pushStep({ label: "take away", undo: () => api.restoreExt(cardId, taken), redo: () => api.unextend(cardId, extId) });
  };

  const remove = async (id: string, label: string) => {
    try {
      const { ids } = await api.hide([id]);
      pushStep({ label, undo: () => api.show(ids), redo: () => api.hide(ids) });
      await refresh();
    } catch (e) {
      setError(`Couldn't remove: ${e}`);
    }
  };

  const undo = async () => {
    const step = undoStack.current.pop();
    if (!step) return;
    await step.undo();
    redoStack.current.push(step);
    bump();
    await refresh();
  };

  const redo = async () => {
    const step = redoStack.current.pop();
    if (!step) return;
    await step.redo();
    undoStack.current.push(step);
    bump();
    await refresh();
  };

  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  const restackRef = useRef<(op: Restack) => void>(() => {});
  undoRef.current = undo;
  redoRef.current = redo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undoRef.current();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redoRef.current();
      } else if (e.code === "BracketRight" || e.code === "BracketLeft") {
        // The usual stacking shortcuts: Ctrl+] forward, Ctrl+[ backward, with Shift to the very front or back.
        e.preventDefault();
        const up = e.code === "BracketRight";
        restackRef.current(e.shiftKey ? (up ? "front" : "back") : up ? "forward" : "backward");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nextUndo = undoStack.current.at(-1);
  const nextRedo = redoStack.current.at(-1);

  // While dragging, draw the dragged items at their new place; the log changes only on release.
  const shown = useMemo(() => {
    if (!drag) return items;
    const moving = new Set(drag.ids);
    return items.map((i) =>
      moving.has(i.id) && i.kind !== "region" ? { ...i, x: drag.orig[i.id].x + drag.dx, y: drag.orig[i.id].y + drag.dy } : i,
    );
  }, [items, drag]);
  const byId = useMemo(() => new Map(shown.map((i) => [i.id, i])), [shown]);
  const images = shown.filter((i): i is ImageItem => i.kind === "image");
  const regions = shown.filter((i): i is RegionItem => i.kind === "region");
  const cards = shown.filter((i): i is CardItem => i.kind === "card");
  const notes = shown.filter((i): i is NoteItem => i.kind === "note");

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const r = stageRef.current!.getBoundingClientRect();
      return { x: (clientX - r.left - view.x) / view.scale, y: (clientY - r.top - view.y) / view.scale };
    },
    [view],
  );

  /** Where a region's rectangle sits on the canvas. */
  const regionWorld = (region: RegionItem): Rect | null => {
    const img = byId.get(region.imageId);
    if (img?.kind !== "image") return null;
    const k = img.w / img.naturalW;
    return { x: img.x + region.rect.x * k, y: img.y + region.rect.y * k, w: region.rect.w * k, h: region.rect.h * k };
  };

  /** How tall a card is, or will be: an unfinished card still grows, so it gets the full reserve. */
  const cardHeight = (c: CardItem) => {
    const measured = heights[c.id] ?? 0;
    return isPending(c) ? Math.max(measured, PENDING_HEIGHT) : measured || PENDING_HEIGHT;
  };

  /** How tall a card is drawn right now: for lines that meet it, not the room kept for it to grow. */
  const drawnHeight = (c: CardItem) => heights[c.id] || cardHeight(c);

  /**
   * First free y at or below `wanted` for a new card at x. The new card is assumed to be as tall
   * as the reserve, since it hasn't been written yet. Placement is decided once and never revisited.
   */
  // Spots promised to things still on their way (a video asked for while another loads), so the
  // next one placed doesn't land on top of them.
  const promised = useRef<{ key: string; id?: string; x: number; y: number; w: number; h: number }[]>([]);
  // Once the item itself is drawn, it holds its own space.
  useEffect(() => {
    promised.current = promised.current.filter((p) => !p.id || !shown.some((i) => i.id === p.id));
  });
  const slotY = (x: number, wanted: number, tall = PENDING_HEIGHT) => {
    let y = wanted;
    const column = [
      ...cards.map((c) => ({ x: c.x, w: c.w, y: c.y, h: cardHeight(c) })),
      ...images.map((i) => ({ x: i.x, w: i.w, y: i.y, h: i.h })),
      ...notes.map((n) => ({ x: n.x, w: n.w, y: n.y, h: n.h ?? 200 })),
      ...promised.current,
    ]
      .filter((c) => c.x < x + CARD_WIDTH && x < c.x + c.w)
      .sort((a, b) => a.y - b.y);
    let moved = true;
    while (moved) {
      moved = false;
      for (const c of column) {
        const bottom = c.y + c.h;
        if (y < bottom + STACK_GAP && y + tall > c.y - STACK_GAP) {
          y = bottom + STACK_GAP;
          moved = true;
        }
      }
    }
    return y;
  };

  // ---- Dropping and pasting images ----

  const placeImage = async (file: File, at: { x: number; y: number }) => {
    if (!file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    try {
      const el = new Image();
      el.src = url;
      await el.decode();
      const w = Math.min(el.naturalWidth, MAX_IMAGE_WIDTH);
      const h = Math.round((el.naturalHeight * w) / el.naturalWidth);
      const img = await api.addImage(file, { x: Math.round(at.x), y: Math.round(at.y), w, h, naturalW: el.naturalWidth, naturalH: el.naturalHeight });
      added("add image", [img.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't add image: ${e}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  // ---- Starting from a link or a statement ----

  /** Puts a source card in clear space to the right of everything and brings it into view. */
  /** Starts from a link or words: to the right of everything, or at `at` (beside the card it came from). */
  const startFrom = async (input: string, at?: { x: number; y: number }): Promise<string | undefined> => {
    const r = stageRef.current!.getBoundingClientRect();
    const right = Math.max(0, ...shown.filter((i) => i.kind !== "region").map((i) => i.x + i.w));
    const x = at?.x ?? (shown.length ? right + 120 : 40);
    const y = at?.y ?? Math.round(toWorld(r.left, r.top + 60).y);
    // A PDF takes a while: it's fetched and sliced into its pages.
    const pdf = /\.pdf($|[?#])|arxiv\.org\/(abs|pdf)\//i.test(input);
    const done = pdf ? expect({ x, y, label: "", text: "Fetching the PDF…" }) : () => {};
    try {
      const res = await api.addSource(input, x, y);
      const id = (res.card ?? res.image)!.id;
      added(res.image?.doc ? "add a PDF" : "start from", [id]);
      await refresh();
      setView((v) => ({ ...v, x: r.width * 0.06 - x * v.scale, y: 60 - y * v.scale }));
      setSelected(id);
      return id;
    } catch (e) {
      setError(`Couldn't start from that: ${e}`);
      // Asked for from a card ("+ Add" on a found page): its button goes back to Add.
      if (at) throw e;
    } finally {
      done();
    }
  };

  /**
   * A video chosen from a set of videos plays on the canvas, beside the set, as a video of its own:
   * so it can be stopped where it loses you, like any other. One already there is gone to instead.
   */
  const [autoPlayId, setAutoPlayId] = useState<string | null>(null);
  const playOnCanvas = async (from: CardItem, videoId: string, url: string) => {
    const there = images.find((i) => i.video?.videoId === videoId);
    if (there) {
      focusOn(there.id);
      setAutoPlayId(there.id);
      players.get(there.id)?.playVideo();
      return;
    }
    // Asked for again while it's still loading: once is enough.
    if (promised.current.some((p) => p.key === videoId)) return;
    const x = from.x + from.w + GAP;
    const h = Math.round((VIDEO_WIDTH * 9) / 16) + 120;
    const spot: (typeof promised.current)[number] = { key: videoId, x, y: slotY(x, from.y, h), w: VIDEO_WIDTH, h };
    promised.current.push(spot);
    const id = await startFrom(url, { x, y: spot.y }).catch(() => undefined);
    if (id) {
      spot.id = id;
      setAutoPlayId(id);
    } else promised.current = promised.current.filter((p) => p !== spot);
  };

  // ---- Papers from arXiv ----

  // The arXiv search, opened from Add (with what was typed there), or closed.
  const [arxivOpen, setArxivOpen] = useState<string | false>(false);

  /**
   * Renders the chosen pages of a paper and lays them side by side, starting at `at` (or near the
   * middle of the view). One step to undo, however many pages.
   */
  const tryExample = async (ex: Example) => {
    try {
      await runExample(ex, (input) => startFrom(input).then(() => {}), (paper, pages) => addPaperPages(paper, pages));
    } catch (e) {
      setError(`Couldn't start the example: ${e}`);
    }
  };

  // A canvas made from an example on the home page (/c/<id>?example=<key>) starts it once, when empty.
  const exampleStarted = useRef(false);
  useEffect(() => {
    if (!loaded || exampleStarted.current) return;
    exampleStarted.current = true;
    // Or what was typed on the home page, handed over in this tab's storage (not the address).
    const typed = takeTypedStart(canvasId);
    if (typed) {
      if (shown.length === 0) void startFrom(typed);
      return;
    }
    const ex = exampleByKey(new URLSearchParams(location.search).get("example"));
    if (!ex) return;
    history.replaceState(null, "", location.pathname);
    if (shown.length === 0) void tryExample(ex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const addPaperPages = async (paper: Paper, pagesSpec: string, at?: { x: number; y: number }) => {
    const { pages } = await renderPaperPages(paper, pagesSpec);
    if (!pages.length) throw new Error("none of those pages exist in this paper");
    // Without a spot asked for, start in clear space: to the right of everything on the canvas,
    // level with the top of the view. Pages then come into view.
    const r = stageRef.current!.getBoundingClientRect();
    const right = Math.max(0, ...shown.filter((i) => i.kind !== "region").map((i) => i.x + i.w));
    let { x, y } = at ?? { x: right + 120, y: toWorld(r.left, r.top + 60).y };
    const ids: string[] = [];
    for (const p of pages) {
      const w = Math.min(p.width / 2, MAX_IMAGE_WIDTH);
      const h = Math.round((p.height * w) / p.width);
      const img = await api.addImage(p.file, { x: Math.round(x), y: Math.round(y), w, h, naturalW: p.width, naturalH: p.height }, p.source);
      ids.push(img.id);
      x += w + 48;
    }
    added(`add ${pages.length} page${pages.length > 1 ? "s" : ""} of arXiv ${paper.id}`, ids);
    await refresh();
    if (!at) setView((v) => ({ ...v, x: r.width * 0.1 - (right + 120) * v.scale }));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    Array.from(e.dataTransfer.files).forEach((f, i) => placeImage(f, { x: at.x + i * 40, y: at.y + i * 40 }));
  };

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!file || !stageRef.current) return;
      const r = stageRef.current.getBoundingClientRect();
      placeImage(file, toWorld(r.left + r.width / 3, r.top + r.height / 4));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // ---- Pan and zoom ----

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const r = stageRef.current!.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const scale = Math.min(3, Math.max(0.1, v.scale * Math.exp(-e.deltaY * 0.0025)));
        return { scale, x: px - ((px - v.x) * scale) / v.scale, y: py - ((py - v.y) * scale) / v.scale };
      });
    } else if (e.shiftKey && !e.deltaX) {
      // Shift+scroll goes sideways (some browsers already turn it into deltaX; the rest send it as deltaY).
      setView((v) => ({ ...v, x: v.x - e.deltaY }));
    } else {
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  };

  // Touch: two fingers pinch to zoom and pan; one finger on a card's text pans, since on a phone
  // cards cover most of the screen and empty canvas is hard to find. A long press still selects text.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; cx: number; cy: number; v: View } | null = null;
    const two = () => {
      const [a, b] = [...pts.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        // A second finger turns whatever the first one started into a pinch.
        pan.current = null;
        setDrag(null);
        setDraft(null);
        setLink(null);
        pinch = { ...two(), v: viewRef.current };
        e.stopPropagation();
        return;
      }
      const t = e.target as HTMLElement;
      const onCardText = t.closest(".card-item") && !t.closest("button, a, input, textarea, select, label, .card-head, .sem-title, .port, .ask");
      if (onCardText) {
        pan.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
        el.setPointerCapture(e.pointerId);
      }
    };
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || pts.size < 2) return;
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      const now = two();
      const p = pinch;
      const scale = Math.min(3, Math.max(0.1, (p.v.scale * now.d) / p.d));
      // The point under the fingers' midpoint stays under it, and moving both fingers pans.
      const wx = (p.cx - r.left - p.v.x) / p.v.scale;
      const wy = (p.cy - r.top - p.v.y) / p.v.scale;
      setView({ scale, x: now.cx - r.left - wx * scale, y: now.cy - r.top - wy * scale });
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) pan.current = null;
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move, true);
    el.addEventListener("pointerup", up, true);
    el.addEventListener("pointercancel", up, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move, true);
      el.removeEventListener("pointerup", up, true);
      el.removeEventListener("pointercancel", up, true);
    };
  }, []);

  // Ctrl+wheel must not zoom the whole browser page.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => (e.ctrlKey || e.metaKey) && e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  // Shift-drag draws a box: whatever it touches is picked, to delete together. It starts anywhere
  // but inside a card (where Shift extends a selection of words) or on a control.
  const onStagePointerDownCapture = (e: React.PointerEvent) => {
    if (!e.shiftKey || e.button !== 0 || panning) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, a, input, textarea, select, [data-card-id], .relation-menu, .picked-bar")) return;
    e.preventDefault();
    e.stopPropagation();
    const p = toWorld(e.clientX, e.clientY);
    setMarquee({ start: p, end: p });
    stageRef.current?.setPointerCapture(e.pointerId);
  };

  /** What a box drawn on the canvas touches: whole things (cards, images, PDFs, videos, notes). */
  const touchedBy = (m: NonNullable<typeof marquee>): string[] => {
    const x0 = Math.min(m.start.x, m.end.x);
    const x1 = Math.max(m.start.x, m.end.x);
    const y0 = Math.min(m.start.y, m.end.y);
    const y1 = Math.max(m.start.y, m.end.y);
    const hit = (b: { x: number; y: number; w: number; h: number }) => b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0;
    const out: string[] = [];
    for (const i of shown) {
      if (folded.has(i.id)) continue;
      const b = i.kind === "card" || i.kind === "image" ? relBox(i.id) : i.kind === "note" ? { x: i.x, y: i.y, w: i.w, h: heights[i.id] ?? 120 } : null;
      if (b && hit(b)) out.push(i.id);
    }
    return out;
  };

  /** Deletes everything picked (and what hangs off it), as one step to undo. */
  const deletePicked = async () => {
    const ids = [...picked];
    if (!ids.length) return;
    setPicked(new Set());
    try {
      const hidden = (await api.hide(ids)).ids;
      pushStep({ label: `delete ${ids.length} thing${ids.length > 1 ? "s" : ""}`, undo: () => api.show(hidden), redo: () => api.hide(hidden) });
      await refresh();
    } catch (e) {
      setError(`Couldn't delete them: ${e}`);
    }
  };
  const deletePickedRef = useRef(deletePicked);
  deletePickedRef.current = deletePicked;
  const pickedCount = useRef(0);
  pickedCount.current = picked.size;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pickedCount.current || isTyping(e.target)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        void deletePickedRef.current();
      } else if (e.key === "Escape") setPicked(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pan mode (or Space, or the middle button) drags from anywhere; select mode only from empty canvas.
  const onStagePointerDown = (e: React.PointerEvent) => {
    const onBackground = e.target === e.currentTarget || Boolean((e.target as HTMLElement).dataset.pan);
    const isButton = (e.target as HTMLElement).closest("button, a");
    if (!(panning || e.button === 1 || (onBackground && e.button === 0)) || (isButton && !panning)) return;
    e.preventDefault();
    if (onBackground) {
      setSelected(null);
      setPicked(new Set());
    }
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // ---- Moving containers ----

  /** The item and everything hanging off it: an image's boxes and cards, a card's cards. */
  const subtree = (rootId: string): string[] => {
    const out = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of items) {
        if (out.has(i.id)) continue;
        // A note moves with what it's about.
        const parent = i.kind === "region" ? i.imageId : i.kind === "card" ? i.parentId : i.kind === "note" ? i.on?.id : undefined;
        if (parent && out.has(parent)) {
          out.add(i.id);
          grew = true;
        }
      }
    }
    return [...out];
  };

  /** The rectangle of what a card explains: the box on the image, or the card it came from. */
  const sourceBox = (card: CardItem): Box | null => {
    const parent = byId.get(card.parentId);
    if (parent?.kind === "card") return { left: parent.x, right: parent.x + parent.w, top: parent.y, bottom: parent.y + drawnHeight(parent) };
    if (parent?.kind === "region") {
      const r = regionWorld(parent);
      return r ? { left: r.x, right: r.x + r.w, top: r.y, bottom: r.y + r.h } : null;
    }
    return null;
  };

  /** Which side of its source a card sits on; new descents from it go the same way. */
  const dirOf = (card: CardItem): Dir => {
    const s = sourceBox(card);
    if (!s || card.x >= s.right) return "right";
    if (card.x + card.w <= s.left) return "left";
    return card.y >= s.bottom ? "below" : "above";
  };

  const startMove = (rootId: string, e: React.PointerEvent) => {
    if (panning || e.button !== 0) return;
    setSelected(rootId);
    e.stopPropagation();
    e.preventDefault();
    const ids = subtree(rootId);
    const orig: Record<string, { x: number; y: number }> = {};
    for (const id of ids) {
      const i = byId.get(id);
      if (i && i.kind !== "region") orig[id] = { x: i.x, y: i.y };
    }
    // A card can sit on any side of what it explains, but not on it: a drag that lands on the
    // source slides out to the nearest free edge.
    const root = byId.get(rootId);
    let avoid: NonNullable<typeof drag>["avoid"] = null;
    if (root?.kind === "card" && !root.relates) {
      const s = sourceBox(root);
      const g = MIN_CHILD_GAP;
      if (s) avoid = { box: { left: s.left - g, right: s.right + g, top: s.top - g, bottom: s.bottom + g }, w: root.w, h: cardHeight(root), x0: root.x, y0: root.y };
    }
    setDrag({ ids, start: toWorld(e.clientX, e.clientY), orig, avoid, dx: 0, dy: 0 });
    stageRef.current?.setPointerCapture(e.pointerId);
  };

  /**
   * Drags a card's right edge: wider (or narrower). The cards it explains that sit to its right
   * keep their distance from its edge, moving with it.
   */
  const startResize = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // By touch, a bare drag on the border pans like anywhere else: a tap arms it first, then a drag resizes.
    if (e.pointerType === "touch" && resizeArmed !== id) {
      const x0 = e.clientX;
      const y0 = e.clientY;
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointerup", up);
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) {
          setSelected(id);
          setResizeArmed(id);
        }
      };
      window.addEventListener("pointerup", up);
      return;
    }
    // Armed (or a mouse): resize, and the pan a touch on a card starts doesn't.
    pan.current = null;
    const card = byId.get(id);
    if (card?.kind !== "card") return;
    e.stopPropagation();
    e.preventDefault();
    setSelected(id);
    const x0 = e.clientX;
    const w0 = card.w;
    const edge = card.x + w0;
    const along: Record<string, number> = {};
    for (const sid of subtree(id)) {
      const i = byId.get(sid);
      if (sid !== id && i?.kind === "card" && i.x >= edge - 1) along[sid] = i.x;
    }
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, w0 + (ev.clientX - x0) / view.scale)));
      setItems((all) => all.map((i) => (i.id === id && i.kind === "card" ? { ...i, w } : i.id in along && i.kind === "card" ? { ...i, x: along[i.id] + w - w0 } : i)));
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      if (Math.abs(w - w0) < 2) return;
      const to = [{ id, x: card.x, y: card.y, w }, ...Object.entries(along).map(([sid, x]) => ({ id: sid, x: x + w - w0, y: (byId.get(sid) as CardItem).y }))];
      const from = [{ id, x: card.x, y: card.y, w: w0 }, ...Object.entries(along).map(([sid, x]) => ({ id: sid, x, y: (byId.get(sid) as CardItem).y }))];
      try {
        await api.move(to);
        pushStep({ label: "resize", undo: () => api.move(from), redo: () => api.move(to) });
      } catch (err) {
        setError(`Couldn't resize: ${err}`);
      }
      await refresh();
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Drags a video's corner or right edge: bigger or smaller, keeping its shape. One undoable step. */
  const startVideoResize = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const img = byId.get(id);
    if (img?.kind !== "image" || !img.video) return;
    e.stopPropagation();
    e.preventDefault();
    pan.current = null;
    setSelected(id);
    const x0 = e.clientX;
    const w0 = img.w;
    const h0 = img.h;
    let w = w0;
    const move = (ev: PointerEvent) => {
      w = Math.round(Math.min(VIDEO_MAX_WIDTH, Math.max(VIDEO_MIN_WIDTH, w0 + (ev.clientX - x0) / view.scale)));
      setItems((all) => all.map((i) => (i.id === id && i.kind === "image" ? { ...i, w, h: Math.round((w * h0) / w0) } : i)));
    };
    const up = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      if (Math.abs(w - w0) < 2) return;
      const to = [{ id, x: img.x, y: img.y, w }];
      const from = [{ id, x: img.x, y: img.y, w: w0 }];
      try {
        await api.move(to);
        pushStep({ label: "resize", undo: () => api.move(from), redo: () => api.move(to) });
      } catch (err) {
        setError(`Couldn't resize: ${err}`);
      }
      await refresh();
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /**
   * The learner's "make room": pushes overlapping cards straight down, each bringing the cards
   * below it in the descent, until nothing overlaps. Only y changes, so every card stays right
   * of what it explains. One undoable step.
   */
  const untangle = async () => {
    const pos = new Map(cards.map((c) => [c.id, { x: c.x, y: c.y }]));
    const kids = new Map<string, string[]>();
    for (const c of cards) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c.id]);
    const below = (id: string): string[] => (kids.get(id) ?? []).flatMap((k) => [k, ...below(k)]);
    const h = new Map(cards.map((c) => [c.id, cardHeight(c)]));
    const w = new Map(cards.map((c) => [c.id, c.w]));

    for (let pass = 0; pass < 500; pass++) {
      let fix: { id: string; dy: number } | null = null;
      const order = [...pos.entries()].sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x);
      outer: for (let i = 0; i < order.length; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const [aId, a] = order[i];
          const [bId, b] = order[j];
          const xOverlap = a.x < b.x + w.get(bId)! && b.x < a.x + w.get(aId)!;
          const yOverlap = b.y < a.y + h.get(aId)! + STACK_GAP;
          if (xOverlap && yOverlap) {
            fix = { id: bId, dy: a.y + h.get(aId)! + STACK_GAP - b.y };
            break outer;
          }
        }
      }
      if (!fix) break;
      for (const id of [fix.id, ...below(fix.id)]) pos.get(id)!.y += fix.dy;
    }

    const changed = cards.filter((c) => pos.get(c.id)!.y !== c.y);
    if (!changed.length) return;
    const to = changed.map((c) => ({ id: c.id, x: c.x, y: Math.round(pos.get(c.id)!.y), h: heights[c.id] }));
    const from = changed.map((c) => ({ id: c.id, x: c.x, y: c.y, h: heights[c.id] }));
    try {
      await api.move(to);
      pushStep({ label: "untangle", undo: () => api.move(from), redo: () => api.move(to) });
    } catch (e) {
      setError(`Couldn't untangle: ${e}`);
    }
    await refresh();
  };

  const finishMove = async (d: NonNullable<typeof drag>) => {
    setDrag(null);
    if (Math.abs(d.dx) + Math.abs(d.dy) < 3) return;
    // Cards report their drawn height, so the server can check above and below as well as beside.
    const h = (id: string) => (byId.get(id)?.kind === "card" ? heights[id] : undefined);
    const to = Object.entries(d.orig).map(([id, p]) => ({ id, x: Math.round(p.x + d.dx), y: Math.round(p.y + d.dy), h: h(id) }));
    const from = Object.entries(d.orig).map(([id, p]) => ({ id, x: p.x, y: p.y, h: h(id) }));
    // Show the new place at once; the refresh confirms it.
    setItems((all) => all.map((i) => (d.orig[i.id] && i.kind !== "region" ? { ...i, x: i.x + d.dx, y: i.y + d.dy } : i)));
    try {
      await api.move(to);
      pushStep({ label: "move", undo: () => api.move(from), redo: () => api.move(to) });
    } catch (e) {
      setError(`Couldn't move: ${e}`);
    }
    await refresh();
  };

  // ---- Asking how two things relate ----

  /** The drawn box of something a relation can join: a card, or a whole image (a collapsed one is its grip). */
  const relBox = (id: string): { x: number; y: number; w: number; h: number } | null => {
    const i = byId.get(id);
    if (i?.kind === "card") return { x: i.x, y: i.y, w: i.w, h: drawnHeight(i) };
    if (i?.kind === "image") return i.collapsed ? { x: i.x, y: i.y - 26, w: i.w, h: 22 } : { x: i.x, y: i.y, w: i.w, h: i.h + (i.video ? STOP_BAR : i.doc ? PAGER_BAR : 0) };
    return null;
  };

  const startLink = (fromId: string, side: Side, e: React.PointerEvent) => {
    if (panning || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const c = relBox(fromId);
    if (!c) return;
    const start =
      side === "left" ? { x: c.x, y: c.y + 28 }
      : side === "right" ? { x: c.x + c.w, y: c.y + 28 }
      : side === "top" ? { x: c.x + c.w / 2, y: c.y }
      : { x: c.x + c.w / 2, y: c.y + c.h };
    setLink({ from: fromId, side, start, end: start });
    stageRef.current?.setPointerCapture(e.pointerId);
  };

  const finishLink = async (l: NonNullable<typeof link>, clientX: number, clientY: number) => {
    setLink(null);
    // Drop on a card, or on a slide (the image itself or its grip).
    const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-card-id], [data-image-id]");
    const toId = target?.dataset.cardId ?? target?.dataset.imageId;
    const a = relBox(l.from);
    const b = toId ? relBox(toId) : null;
    if (!a || !b || !toId || toId === l.from) return;
    const aId = l.from;
    const bId = toId;
    // The answer goes toward the side the connection was dragged from: under both from a bottom
    // port, over both from a top port, beside both from a side port.
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    const midX = Math.round((a.x + a.w / 2 + b.x + b.w / 2) / 2 - CARD_WIDTH / 2);
    let x = midX;
    let y: number;
    if (l.side === "top") {
      y = Math.round(top - 64 - PENDING_HEIGHT);
    } else if (l.side === "left") {
      x = Math.round(Math.min(a.x, b.x) - GAP - CARD_WIDTH);
      y = slotY(x, Math.round(top));
    } else if (l.side === "right") {
      x = Math.round(Math.max(a.x + a.w, b.x + b.w) + GAP);
      y = slotY(x, Math.round(top));
    } else {
      y = slotY(x, Math.round(bottom + 64));
    }
    // What to ask about them: chosen from a menu where the connection was dropped.
    setRelAsk({ a: aId, b: bId, x, y, left: clientX, top: clientY, line: { start: l.start, end: l.end } });
  };

  const relateAs = async (kind: RelationKind) => {
    const r = relAsk;
    setRelAsk(null);
    if (!r) return;
    try {
      const res = await api.relate({ a: r.a, b: r.b, x: r.x, y: r.y, kind });
      added("relate", [res.card.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't ask about them: ${e}`);
    }
  };

  const onStagePointerMove = (e: React.PointerEvent) => {
    if (marquee) return setMarquee({ ...marquee, end: toWorld(e.clientX, e.clientY) });
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
    } else if (link) {
      setLink({ ...link, end: toWorld(e.clientX, e.clientY) });
    } else if (drag) {
      const p = toWorld(e.clientX, e.clientY);
      let dx = p.x - drag.start.x;
      let dy = p.y - drag.start.y;
      const a = drag.avoid;
      if (a) {
        const x = a.x0 + dx;
        const y = a.y0 + dy;
        const b = a.box;
        if (x < b.right && x + a.w > b.left && y < b.bottom && y + a.h > b.top) {
          // Slide out along whichever edge is nearest.
          const outs = [
            { d: x + a.w - b.left, x: b.left - a.w, y },
            { d: b.right - x, x: b.right, y },
            { d: y + a.h - b.top, x, y: b.top - a.h },
            { d: b.bottom - y, x, y: b.bottom },
          ].sort((m, n) => m.d - n.d);
          dx = outs[0].x - a.x0;
          dy = outs[0].y - a.y0;
        }
      }
      setDrag({ ...drag, dx, dy });
    } else if (draft) {
      setDraft({ ...draft, end: toWorld(e.clientX, e.clientY) });
    }
  };

  const onStagePointerUp = async (e: React.PointerEvent) => {
    pan.current = null;
    if (marquee) {
      const m = marquee;
      setMarquee(null);
      // Adds to what's already picked, so several boxes can gather things from around the canvas.
      setPicked((was) => new Set([...was, ...touchedBy(m)]));
      return;
    }
    if (link) return finishLink(link, e.clientX, e.clientY);
    if (drag) return finishMove(drag);
    if (!draft) return;
    const d = draft;
    setDraft(null);
    const img = byId.get(d.imageId);
    if (img?.kind !== "image") return;
    await explainArea(img, { x0: Math.min(d.start.x, d.end.x), y0: Math.min(d.start.y, d.end.y), x1: Math.max(d.start.x, d.end.x), y1: Math.max(d.start.y, d.end.y) });
  };

  /**
   * Explains an area of an image (in canvas coordinates): a box drawn on it, or the lines of words
   * selected on a PDF page, with `text` their exact words.
   */
  const explainArea = async (img: ImageItem, area: { x0: number; y0: number; x1: number; y1: number }, text?: string) => {
    // Clamp to the image, then convert to the image's natural pixels.
    const x0 = Math.max(img.x, area.x0);
    const y0 = Math.max(img.y, area.y0);
    const x1 = Math.min(img.x + img.w, area.x1);
    const y1 = Math.min(img.y + img.h, area.y1);
    if (x1 - x0 < 8 || y1 - y0 < 8) return;
    const k = img.naturalW / img.w;
    const rect = { x: Math.round((x0 - img.x) * k), y: Math.round((y0 - img.y) * k), w: Math.round((x1 - x0) * k), h: Math.round((y1 - y0) * k) };
    const el = imgRefs.current[img.id];
    if (!el) return;
    const cardX = img.x + img.w + GAP;
    const cardY = slotY(cardX, Math.round(y0));
    const done = expect({ x: cardX, y: cardY, label: text ?? "", box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
    try {
      const { marked, crop } = renderRegion(el, rect);
      const res = await api.addRegion({ imageId: img.id, rect, card: { x: cardX, y: cardY }, marked, crop, ...(text ? { text } : {}) });
      added("box", [res.region.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't send the selection: ${e}`);
    } finally {
      done();
    }
  };

  // ---- Descending from a card ----

  const descend = async (parent: CardItem, selection: string, context: string, worldY: number) => {
    // Grow the same way as the branch: a card put left of, above or below its source sends its
    // own descents further that way.
    const dir = dirOf(parent);
    const x = dir === "left" ? parent.x - GAP - CARD_WIDTH : dir === "right" ? parent.x + parent.w + GAP : parent.x;
    const vertical = dir === "below" ? parent.y + cardHeight(parent) + STACK_GAP * 2 : dir === "above" ? parent.y - STACK_GAP * 2 - PENDING_HEIGHT : null;
    const y = vertical === null ? slotY(x, Math.round(worldY - 20)) : dir === "below" ? slotY(x, Math.round(vertical)) : Math.round(vertical);
    const done = expect({ x, y, label: selection, parentId: parent.id });
    try {
      const res = await api.descend({ parentId: parent.id, selection, context, x, y });
      added(`explain “${selection.slice(0, 30)}”`, [res.card.id]);
      await refresh();
      return res.card.id;
    } catch (e) {
      setError(`Couldn't go further down: ${e}`);
    } finally {
      done();
    }
  };

  /** Shows a placeholder where a card is about to land, and returns a function that removes it. */
  const expect = (p: Omit<Pending, "key">) => {
    const key = `${Date.now()}-${Math.random()}`;
    setExpected((all) => [...all, { ...p, key }]);
    return () => setExpected((all) => all.filter((q) => q.key !== key));
  };


  // ---- PDFs: read a page at a time, and a page taken out to work on ----

  // The page each PDF is open at, kept in this browser so it reopens where it was left.
  const [docPages, setDocPages] = useState<Record<string, number>>({});
  const docPage = (id: string) => {
    if (docPages[id]) return docPages[id];
    try {
      return Number(localStorage.getItem(`librarian.docpage.${canvasId}.${id}`)) || 1;
    } catch {
      return 1;
    }
  };
  const turnTo = (id: string, n: number) => {
    setDocPages((all) => ({ ...all, [id]: n }));
    try {
      localStorage.setItem(`librarian.docpage.${canvasId}.${id}`, String(n));
    } catch {
      // Not kept: it opens at page 1 next time.
    }
  };

  /** Takes a page out: beside the PDF, below the pages already taken from it. */
  const takePage = async (doc: ImageItem, n: number) => {
    const x = doc.x + doc.w + GAP;
    let below = doc.y;
    for (const m of images) if (m.pdf?.doc === doc.id) below = Math.max(below, m.y + m.h + STACK_GAP * 2);
    const y = slotY(x, below);
    const done = expect({ x, y, label: "", text: `Taking out page ${n}…` });
    try {
      const res = await api.takePage(doc.id, n, x, y);
      added(`take out page ${n}`, [res.image.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't take that page out: ${e}`);
    } finally {
      done();
    }
  };

  // ---- Video moments ----

  /** Stops a video: its frame and what was said land beside it, below earlier moments. */
  const stopAt = async (video: ImageItem, t: number) => {
    // Below this video's earlier moments, each a frame with its transcript card under it.
    const x = video.x + video.w + GAP;
    let below = video.y;
    for (const m of images) {
      if (m.moment?.videoImageId !== video.id) continue;
      below = Math.max(below, m.y + m.h + STACK_GAP * 2);
      for (const c of cards) if (c.parentId === m.id) below = Math.max(below, c.y + cardHeight(c) + STACK_GAP * 2);
    }
    const y = slotY(x, below);
    const done = expect({ x, y, label: "", text: `Grabbing the frame at ${clock(t)} and what was said…` });
    try {
      const res = await api.moment(video.id, t, x, y);
      added(`stop at ${clock(t)}`, [res.image.id, ...(res.card ? [res.card.id] : [])]);
      await refresh();
    } catch (e) {
      setError(`Couldn't grab that moment: ${e}`);
    } finally {
      done();
    }
  };

  /** Takes a moment's video back to it: scrolls to the video and plays from there. */
  const resume = (m: NonNullable<ImageItem["moment"]>) => {
    focusOn(m.videoImageId);
    const p = players.get(m.videoImageId);
    if (!p) return;
    p.seekTo(m.t, true);
    p.playVideo();
  };

  const answer = async (card: CardItem, text: string) => {
    try {
      await api.answer(card.id, text);
      await refresh();
    } catch (e) {
      setError(`Couldn't send your answer: ${e}`);
    }
  };

  const retry = async (card: CardItem, auto = false) => {
    try {
      const parent = byId.get(card.parentId);
      if (parent?.kind === "region") {
        const el = imgRefs.current[parent.imageId];
        if (!el) throw new Error("its image isn't on the canvas");
        await api.retry(card.id, renderRegion(el, parent.rect), auto);
      } else {
        await api.retry(card.id, undefined, auto);
      }
      await refresh();
    } catch (e) {
      if (!auto) setError(`Couldn't retry: ${e}`);
    }
  };

  // The server tries failed cards again by itself; a box on a slide needs its crop from here, so
  // when one's next try is due, the page makes it.
  const autoTried = useRef(new Set<string>());
  useEffect(() => {
    const due = cards.filter((c) => c.stage === "failed" && c.retryAt && byId.get(c.parentId)?.kind === "region" && !c.origin && !c.objectKind && !c.relates);
    if (!due.length) return;
    const timers = due.map((c) =>
      setTimeout(() => {
        const key = `${c.id}@${c.retryAt}`;
        if (autoTried.current.has(key)) return;
        autoTried.current.add(key);
        void retry(c, true);
      }, Math.max(0, Date.parse(c.retryAt!) - Date.now())),
    );
    return () => timers.forEach(clearTimeout);
  });

  // ---- Collapsing ----
  // A collapsed image or card keeps its place and shows only its title; everything hanging off
  // it is out of view until it's expanded. Folded cards still hold their space, so expanding
  // never lands on top of anything.

  // ---- Stacking: front, back, forward, backward ----
  // Images and cards are drawn in stack order: their z, then the order they were added.

  const stack = shown
    .filter((i): i is ImageItem | CardItem => i.kind !== "region")
    .map((item, added) => ({ item, added }))
    .sort((a, b) => (a.item.z ?? 0) - (b.item.z ?? 0) || a.added - b.added)
    .map(({ item }) => item);
  const rank = new Map(stack.map((item, i) => [item.id, i + 1]));

  const restack = async (op: Restack) => {
    const id = selected;
    if (!id || !rank.has(id)) return;
    const order = stack.map((i) => i.id);
    const at = order.indexOf(id);
    order.splice(at, 1);
    const to = op === "front" ? order.length : op === "back" ? 0 : op === "forward" ? Math.min(order.length, at + 1) : Math.max(0, at - 1);
    order.splice(to, 0, id);
    // Renumber, and send only what changed.
    const before = new Map(stack.map((i) => [i.id, i.z ?? 0]));
    const next = order.map((oid, i) => ({ id: oid, z: i })).filter((o) => before.get(o.id) !== o.z);
    if (!next.length) return;
    const prev = next.map((o) => ({ id: o.id, z: before.get(o.id)! }));
    setItems((all) => all.map((i) => {
      const n = next.find((o) => o.id === i.id);
      return n ? { ...i, z: n.z } : i;
    }));
    try {
      await api.restack(next);
      pushStep({ label: `stack ${op}`, undo: () => api.restack(prev), redo: () => api.restack(next) });
    } catch (e) {
      setError(`Couldn't restack: ${e}`);
    }
    await refresh();
  };
  restackRef.current = restack;

  const folded = useMemo(() => {
    const out = new Set<string>();
    for (const i of items) if (i.collapsed) for (const id of subtree(i.id)) if (id !== i.id) out.add(id);
    return out;
    // `subtree` reads `items`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const visibleRegions = regions.filter((r) => !folded.has(r.id));
  const visibleCards = cards.filter((c) => !folded.has(c.id));
  const bookmarked = cards.filter((c) => c.bookmarked);
  const cardsBelow = (id: string) => subtree(id).filter((d) => d !== id && byId.get(d)?.kind === "card").length;

  /** Bookmarks a card, or takes its bookmark off: shown at once, saved, and undoable. */
  const bookmark = async (c: CardItem) => {
    const next = !c.bookmarked;
    setItems((all) => all.map((i) => (i.id === c.id ? { ...i, bookmarked: next } : i)));
    try {
      await api.bookmark(c.id, next);
      pushStep({ label: next ? "bookmark" : "remove bookmark", undo: () => api.bookmark(c.id, !next), redo: () => api.bookmark(c.id, next) });
    } catch (e) {
      setError(`Couldn't bookmark it: ${e}`);
    }
    await refresh();
  };

  const toggleCollapse = async (id: string) => {
    const item = byId.get(id);
    if (!item) return;
    const next = !item.collapsed;
    // Show the change at once; the refresh confirms it.
    setItems((all) => all.map((i) => (i.id === id ? { ...i, collapsed: next } : i)));
    try {
      await api.collapse([id], next);
      pushStep({
        label: next ? "collapse" : "expand",
        undo: () => api.collapse([id], !next),
        redo: () => api.collapse([id], next),
      });
    } catch (e) {
      setError(`Couldn't ${next ? "collapse" : "expand"}: ${e}`);
    }
    await refresh();
  };

  /** Brings an item into the middle of the view and selects it. */
  // Goals: the cards they can point at, how many are still open, and the one you're in now (the
  // selected card's, or else the newest card's).
  const cardsById = new Map(cards.map((c) => [c.id, c] as const));
  const openGoals = goals.filter((g) => g.status === "open").length;
  const currentGoal = (() => {
    const of = (id: string | null | undefined) => (id ? goals.find((g) => g.cards.includes(id))?.id : undefined);
    const newest = [...cards].reverse().find((c) => of(c.id));
    return of(selected) ?? of(newest?.id);
  })();

  const focusOn = (id: string) => {
    const item = byId.get(id);
    const el = stageRef.current;
    if (!item || item.kind === "region" || !el) return;
    const r = el.getBoundingClientRect();
    setView((v) => ({ ...v, x: r.width / 2 - (item.x + item.w / 2) * v.scale, y: 80 - item.y * v.scale }));
    setSelected(id);
  };

  useEffect(() => {
    if (focusNext && byId.has(focusNext)) {
      focusOn(focusNext);
      setFocusNext(null);
    }
  });

  // Cards about an image written before pieces pointed into their page: find those places once.
  const looked = useRef(new Set<string>());
  const mapped = useRef(new Set<string>());
  useEffect(() => {
    // Linked pages read before they were restructured whole: do that, once.
    for (const c of cards) {
      if (c.origin?.kind !== "page" || c.stage !== "done" || !c.pageText || c.sections || mapped.current.has(`s${c.id}`)) continue;
      mapped.current.add(`s${c.id}`);
      api.sections(c.id).then(refresh, () => {});
    }
    // Cards written before the course map: look up where their subject is taught, once.
    for (const c of cards) {
      if (c.stage !== "done" || !c.sem || c.taught || c.relates || c.objectKind || mapped.current.has(c.id)) continue;
      mapped.current.add(c.id);
      api.courses(c.id).then(refresh, () => {});
    }
    for (const c of cards) {
      // Also cards whose crops were made before snapping, which drifted along their lines.
      if (c.stage !== "done" || !c.sem || c.looking === "working" || (c.looking && c.snapped) || c.origin || looked.current.has(c.id)) continue;
      let p = byId.get(c.parentId);
      for (let i = 0; p?.kind === "card" && i < 50; i++) p = byId.get(p.parentId);
      if (p?.kind !== "region" && p?.kind !== "image") continue;
      looked.current.add(c.id);
      api.look(c.id).then(refresh, () => {});
    }
  });

  // A notebook just asked for (in a card's chat, or on a call) opens beside the canvas at once,
  // showing its search, and runs when it arrives. Ones already here when the canvas loaded don't.
  useEffect(() => {
    if (!loaded) return;
    const ids = cards.filter((c) => c.objectKind === "notebook").map((c) => c.id);
    if (!seenNotebooks.current) {
      seenNotebooks.current = new Set(ids);
      return;
    }
    // The newest, if several arrive at once.
    const fresh = ids.filter((id) => !seenNotebooks.current!.has(id)).at(-1);
    for (const id of ids) seenNotebooks.current.add(id);
    if (fresh) setNotebook({ id: fresh, autoRun: true });
  });

  // What each card's words have already been explained by, and what's still being explained.
  const explainedIn = new Map<string, string[]>();
  const explainingIn = new Map<string, string[]>();
  for (const p of expected) if (p.parentId) explainingIn.set(p.parentId, [...(explainingIn.get(p.parentId) ?? []), p.label]);
  // Child cards still being written, by parent, with what they're doing.
  const childStages = new Map<string, Record<string, CardStage>>();
  for (const c of cards) if (isPending(c)) childStages.set(c.parentId, { ...childStages.get(c.parentId), [c.id]: c.stage });
  for (const c of visibleCards) {
    if (!c.selection) continue;
    const into = isPending(c) ? explainingIn : explainedIn;
    into.set(c.parentId, [...(into.get(c.parentId) ?? []), c.selection]);
  }

  // Work in progress that's out of view gets a pointer at the edge of the screen, so nothing
  // happens out of sight, and the view only moves if you ask it to.
  const stageBox = stageRef.current?.getBoundingClientRect();
  const offscreen = !stageBox
    ? []
    : [
        ...expected.map((p) => ({ key: p.key, id: null as string | null, x: p.x, y: p.y, label: p.label || (p.text ? "a moment" : "the box you drew") })),
        ...visibleCards.filter(isPending).map((c) => ({ key: c.id, id: c.id as string | null, x: c.x, y: c.y, label: c.selection ?? c.subject ?? "a new card" })),
      ].flatMap((w) => {
        const sx = w.x * view.scale + view.x;
        const sy = w.y * view.scale + view.y;
        const ex = sx + CARD_WIDTH * view.scale;
        const ey = sy + 120 * view.scale;
        if (ex > 0 && sx < stageBox.width && ey > 0 && sy < stageBox.height) return [];
        const dir = sy >= stageBox.height ? "↓" : ey <= 0 ? "↑" : sx >= stageBox.width ? "→" : "←";
        const m = 12;
        const left = dir === "→" ? undefined : dir === "←" ? m : Math.min(Math.max(sx, m), stageBox.width - 260);
        const top = dir === "↓" ? undefined : dir === "↑" ? m : Math.min(Math.max(sy, m + 40), stageBox.height - 60);
        return [{ ...w, dir, style: { left, top, right: dir === "→" ? m : undefined, bottom: dir === "↓" ? 72 : undefined } }];
      });

  // ---- Connectors ----

  const connectors = visibleCards.flatMap((c) => {
    // A relation joins the two things it relates to its card with semshapes connectors: straight
    // runs, 45° bends, heads. What was asked (its kind) picks the shape: a Y-connector for "related",
    // a line into each column for "different" and "disagree" (a bar for opposing), a path through
    // the card for "leads to", a category line from the whole for "part of". Colours are the theme.
    if (c.relates) {
      const kind = c.relKind ?? "relates";
      const boxes = c.relates.map((id) => (folded.has(id) ? null : relBox(id)));
      const card = { x: c.x, y: c.y, w: c.w, h: drawnHeight(c) };
      const lit = hover === c.id || c.relates.some((id) => hover === id);
      const cls = (extra = "") => `connector relation rel-${kind}${extra}${lit ? " lit" : ""}`;
      const out: React.JSX.Element[] = [];
      const draw = (key: string, r: Routed | null, head: "arrow" | "bar" | "hollow" | null, extra = "") => {
        if (!r) return;
        out.push(<path key={key} d={r.d} data-card={c.id} className={cls(extra)} />);
        if (kind === "differs") out.push(<path key={`${key}-g`} d={r.d} className="connector rel-differs-gap" />);
        if (head) out.push(<path key={`${key}-h`} d={relHead(r.end, r.dir, head)} className={`rel-head rel-${kind}${head === "hollow" ? " hollow" : ""}${head === "bar" ? " bar" : ""}`} />);
      };
      if (kind === "relates") {
        // Y-connector: both run to a junction over the card, and one stem carries on into it.
        const entry = relEntry(card, boxes.find(Boolean) ?? card);
        const j = { x: entry.x, y: entry.y - 30 * entry.dir };
        boxes.forEach((b, i) => b && draw(`${c.id}-${i}`, relRoute(b, j), null));
        out.push(<path key={`${c.id}-stem`} d={`M${j.x} ${j.y} L${entry.x} ${entry.y - 9 * entry.dir}`} className={cls()} />);
        out.push(<path key={`${c.id}-stem-h`} d={relHead({ x: entry.x, y: entry.y }, { x: 0, y: entry.dir }, "arrow")} className="rel-head rel-relates" />);
      } else if (kind === "differs" || kind === "disputes") {
        // Each into its own side of the card, kept apart: they are compared, not joined.
        boxes.forEach((b, i) => b && draw(`${c.id}-${i}`, relRoute(b, relEntry(card, b, i === 0 ? 0.34 : 0.68), i === 0 ? 0.4 : 0.6), kind === "disputes" ? "bar" : "arrow"));
      } else if (kind === "leads") {
        // Path: from the one that leads into the card, and out of the card on into the other.
        const f = c.relFrom;
        boxes.forEach((b, i) => {
          if (!b) return;
          if (f === undefined) return draw(`${c.id}-${i}`, relRoute(b, relEntry(card, b)), null);
          if (i === f) draw(`${c.id}-${i}`, relRoute(b, relEntry(card, b)), "arrow");
          else draw(`${c.id}-${i}`, relRouteOut(card, b), "arrow");
        });
      } else {
        // Part of: the whole comes down as a category line; the part joins by the description bend.
        const f = c.relFrom;
        boxes.forEach((b, i) => {
          if (!b) return;
          const whole = f !== undefined && i !== f;
          draw(`${c.id}-${i}`, relRoute(b, relEntry(card, b, i === 0 ? 0.4 : 0.6)), whole ? "arrow" : null, whole ? " rel-whole" : "");
        });
      }
      return out;
    }
    // What was said at a stopped moment describes its frame: the semshapes description connector
    // (a 45° bend off the frame, a straight bus, an arrowhead into the words), not the soft curve
    // of a descent. Routed with straight runs, so it follows wherever either is moved.
    const owner = byId.get(c.parentId);
    if (owner?.kind === "image" && owner.moment) {
      if (folded.has(owner.id)) return [];
      const lit = hover === c.id || hover === owner.id;
      const f = { left: owner.x, right: owner.x + owner.w, top: owner.y, bottom: owner.y + owner.h };
      const BEND = 14;
      const HEAD = 9;
      let d: string;
      let head: string;
      if (c.y >= f.bottom) {
        // Below (where it's put): down from near the frame's left edge.
        const x0 = f.left + 28;
        const bx = x0 + BEND;
        const by = f.bottom + BEND;
        const tx = Math.min(Math.max(bx, c.x + 20), c.x + c.w - 20);
        const ty = c.y;
        const my = Math.max(by, (by + ty) / 2);
        d = tx === bx ? `M${x0} ${f.bottom} L${bx} ${by} L${tx} ${ty - HEAD}` : `M${x0} ${f.bottom} L${bx} ${by} L${bx} ${my} L${tx} ${my} L${tx} ${ty - HEAD}`;
        head = `M${tx - 5} ${ty - HEAD} L${tx + 5} ${ty - HEAD} L${tx} ${ty} Z`;
      } else if (c.y + drawnHeight(c) <= f.top) {
        // Above: the same, upward.
        const x0 = f.left + 28;
        const bx = x0 + BEND;
        const by = f.top - BEND;
        const tx = Math.min(Math.max(bx, c.x + 20), c.x + c.w - 20);
        const ty = c.y + drawnHeight(c);
        const my = Math.min(by, (by + ty) / 2);
        d = `M${x0} ${f.top} L${bx} ${by} L${bx} ${my} L${tx} ${my} L${tx} ${ty + HEAD}`;
        head = `M${tx - 5} ${ty + HEAD} L${tx + 5} ${ty + HEAD} L${tx} ${ty} Z`;
      } else {
        // Beside: out of the frame's facing side, across, into the words' top line.
        const right = c.x >= f.right;
        const sgn = right ? 1 : -1;
        const x0 = right ? f.right : f.left;
        const y0 = f.top + 28;
        const bx = x0 + sgn * BEND;
        const by = y0 + BEND;
        const tx = right ? c.x : c.x + c.w;
        const ty = c.y + 28;
        const mx = (bx + tx) / 2;
        d = `M${x0} ${y0} L${bx} ${by} L${mx} ${by} L${mx} ${ty} L${tx - sgn * HEAD} ${ty}`;
        head = `M${tx - sgn * HEAD} ${ty - 5} L${tx - sgn * HEAD} ${ty + 5} L${tx} ${ty} Z`;
      }
      return [
        <path key={c.id} data-card={c.id} d={d} className={lit ? "connector moment-line lit" : "connector moment-line"} />,
        <path key={`${c.id}-head`} d={head} className={lit ? "moment-head lit" : "moment-head"} />,
      ];
    }
    const s = sourceBox(c);
    if (!s) return [];
    const dir = dirOf(c);
    const lit = hover === c.id || hover === c.parentId;
    // Connect the facing edges: side to side for left and right, bottom to top for above and below.
    const parent = byId.get(c.parentId);
    const midY = parent?.kind === "card" ? s.top + 28 : (s.top + s.bottom) / 2;
    let d: string;
    if (dir === "left" || dir === "right") {
      const from = { x: dir === "left" ? s.left : s.right, y: midY };
      const to = { x: dir === "left" ? c.x + c.w : c.x, y: c.y + 28 };
      const mx = (from.x + to.x) / 2;
      d = `M${from.x} ${from.y} C${mx} ${from.y} ${mx} ${to.y} ${to.x} ${to.y}`;
    } else {
      const from = { x: (s.left + s.right) / 2, y: dir === "below" ? s.bottom : s.top };
      const to = { x: c.x + c.w / 2, y: dir === "below" ? c.y : c.y + drawnHeight(c) };
      const my = (from.y + to.y) / 2;
      d = `M${from.x} ${from.y} C${from.x} ${my} ${to.x} ${my} ${to.x} ${to.y}`;
    }
    // Which card a line leads to, for tests and for recordings that reveal a card with its line.
    return [<path key={c.id} data-card={c.id} d={d} className={lit ? "connector lit" : "connector"} />];
  });

  // A note hangs from what it's about by a dotted line, from that thing's nearer side.
  const noteLines = notes.flatMap((n) => {
    if (!n.on || folded.has(n.on.id)) return [];
    const box = relBox(n.on.id);
    if (!box) return [];
    const right = n.x >= box.x + box.w / 2;
    const from = { x: right ? box.x + box.w : box.x, y: box.y + Math.min(28, box.h / 2) };
    const to = { x: right ? n.x : n.x + n.w, y: n.y + 18 };
    const mx = (from.x + to.x) / 2;
    const lit = hover === n.id || hover === n.on.id;
    return [<path key={`note-${n.id}`} data-card={n.id} d={`M${from.x} ${from.y} C${mx} ${from.y} ${mx} ${to.y} ${to.x} ${to.y}`} className={lit ? "connector note-line lit" : "connector note-line"} />];
  });

  /** Opens a new note: beside what's selected (and about it), else in the middle of the screen. */
  const startNote = () => {
    const sel = selected ? byId.get(selected) : undefined;
    if (sel && (sel.kind === "card" || sel.kind === "image")) {
      const taken = notes.filter((n) => n.on?.id === sel.id).reduce((y, n) => Math.max(y, n.y + (heights[n.id] ?? 120) + 16), sel.y);
      setNoteDraft({ x: sel.x + sel.w + 32, y: taken, on: { id: sel.id } });
      return;
    }
    const r = stageRef.current?.getBoundingClientRect();
    const c = r ? toWorld(r.left + r.width / 2 - 140 * view.scale, r.top + r.height / 3) : { x: 0, y: 0 };
    setNoteDraft({ x: Math.round(c.x), y: Math.round(c.y) });
  };
  startNoteRef.current = startNote;

  const saveNote = async (text: string) => {
    const d = noteDraft;
    setNoteDraft(null);
    if (!d) return;
    try {
      const { note } = await api.addNote({ text, x: d.x, y: d.y, ...(d.on ? { on: d.on } : {}) });
      pushStep({ label: "note", undo: () => api.hide([note.id]), redo: () => api.show([note.id]) });
      await refresh();
    } catch (e) {
      setError(`Couldn't save the note: ${e}`);
    }
  };

  const rewordNote = async (n: NoteItem, text: string) => {
    try {
      await api.editNote(n.id, text);
      pushStep({ label: "edit note", undo: () => api.editNote(n.id, n.text), redo: () => api.editNote(n.id, text) });
      await refresh();
    } catch (e) {
      setError(`Couldn't save the note: ${e}`);
    }
  };

  const draftRect = draft && {
    x: Math.min(draft.start.x, draft.end.x),
    y: Math.min(draft.start.y, draft.end.y),
    w: Math.abs(draft.end.x - draft.start.x),
    h: Math.abs(draft.end.y - draft.start.y),
  };

  if (notFound)
    return (
      <main className="settings">
        <h1>No canvas here</h1>
        <p>
          There's no canvas with the id <code>{canvasId}</code>. <a {...linkTo("/")}>See all canvases</a>
        </p>
      </main>
    );

  return (
    <div className="canvas-page">
      <div className="toolbar">
        <a className="brand" {...linkTo("/")} title="All canvases">
          <Logo />
          Saseo
        </a>
        <span className="muted">/</span>
        <CanvasName name={name} onRename={rename} />
        <CanvasSwitcher currentId={canvasId} />
        {role !== "owner" && (
          <span className="role-chip" title={viewOnly ? "Shared with you to look at" : "Shared with you: what you change is marked as yours"}>
            {viewOnly ? "View only" : "Shared with you"}
          </span>
        )}
        {(admin || !me.accounts) && (
          <a {...linkTo("/settings")} className="muted small">
            Settings
          </a>
        )}
        {anonymous && (
          <span className="save-link">
            <a {...linkTo("/signup")}>Sign up</a> <span className="muted">|</span> <a {...linkTo("/signin")}>Sign in</a>
          </span>
        )}
        <span className="muted small hint">
          Drop or paste an image · Select: drag a box over what's confusing you · hold Space to pan · Ctrl+scroll to zoom
        </span>
        <span className="spacer" />
        {/* Making: what goes on the canvas, the call that does it with you, and taking it back. */}
        {!viewOnly && (
        <div className="tb-group" role="group" aria-label="Add to the canvas">
          {/* Always in its place: on an empty canvas the start box is already open in the middle, so it's only disabled. */}
          <button
            type="button"
            className={dockOpen && shown.length > 0 ? "add-btn on" : "secondary add-btn"}
            disabled={shown.length === 0}
            title={shown.length ? "Add a link, a PDF, a video, a question, or papers from arXiv (/)" : "The canvas is empty: start in the box in the middle"}
            onClick={() => setDockOpen(!dockOpen)}
          >
            + Add <kbd>/</kbd>
          </button>
          <button
            type="button"
            className="secondary note-add-btn"
            title={selected ? "Leave a note about what's selected (N)" : "Leave a note on the canvas (N)"}
            onClick={startNote}
          >
            ✎ Note <kbd>N</kbd>
          </button>
          {canCall && (
            <button type="button" className={calling ? "on call-btn" : "secondary call-btn"} title="Talk with the librarian while you point at things" onClick={() => setCalling(!calling)}>
              {calling ? "On a call" : "Call"}
            </button>
          )}
          <div className="history">
            <button type="button" className="secondary" aria-label="Undo" disabled={!nextUndo} title={nextUndo ? `Undo ${nextUndo.label} (Ctrl+Z)` : "Nothing to undo"} onClick={undo}>
              ↶
            </button>
            <button type="button" className="secondary" aria-label="Redo" disabled={!nextRedo} title={nextRedo ? `Redo ${nextRedo.label} (Ctrl+Shift+Z)` : "Nothing to redo"} onClick={redo}>
              ↷
            </button>
          </div>
        </div>
        )}
        {/* Moving around: the tool, and the zoom. */}
        <div className="tb-group" role="group" aria-label="View">
          <div className="modes" role="radiogroup" aria-label="Canvas tool">
            <button
              type="button"
              role="radio"
              aria-label="Select"
              aria-checked={mode === "select"}
              className={mode === "select" ? "on" : ""}
              title="Select (V): drag a box on an image to explain it, select words in a card to go further down"
              onClick={() => setMode("select")}
            >
              <span aria-hidden>⬚</span> <span className="tb-label">Select</span> <kbd>V</kbd>
            </button>
            <button
              type="button"
              role="radio"
              aria-label="Pan"
              aria-checked={mode === "pan"}
              className={mode === "pan" ? "on" : ""}
              title="Pan (H): drag anywhere to move around. Hold Space for a moment of panning in either mode."
              onClick={() => setMode("pan")}
            >
              <span aria-hidden>✥</span> <span className="tb-label">Pan</span> <kbd>H</kbd>
            </button>
          </div>
          <button type="button" className="link" title="Reset zoom" onClick={() => setView(defaultView())}>
            {Math.round(view.scale * 100)}%
          </button>
        </div>
        {/* Arranging: what's in front of what, and pulling apart what overlaps. */}
        {!viewOnly && (
        <div className="tb-group" role="group" aria-label="Arrange">
          <div className="stacking" role="group" aria-label="Stacking order">
            {(
              [
                ["front", "⤒", "Bring to front (Ctrl+Shift+])"],
                ["forward", "↑", "Bring forward (Ctrl+])"],
                ["backward", "↓", "Send backward (Ctrl+[)"],
                ["back", "⤓", "Send to back (Ctrl+Shift+[)"],
              ] as const
            ).map(([op, icon, label]) => (
              <button key={op} type="button" className="secondary" disabled={!selected} title={selected ? label : `${label}: select a card or an image's grip first`} onClick={() => restack(op)}>
                {icon}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="secondary untangle"
            title="Push overlapping cards down so nothing overlaps (Ctrl+Z undoes it)"
            onClick={untangle}
          >
            Untangle
          </button>
        </div>
        )}
        {/* The panel on the side. */}
        <div className="tb-group" role="group" aria-label="Goals">
          {bookmarked.length > 0 && <Bookmarks cards={bookmarked} onShow={focusOn} />}
          <button
            type="button"
            className={goalsOpen ? "on goals-btn" : "secondary goals-btn"}
            title="What you're after, and what it took to get there"
            onClick={() => {
              setGoalsOpen(!goalsOpen);
              try {
                localStorage.setItem("librarian.goalsOpen", goalsOpen ? "0" : "1");
              } catch {}
            }}
          >
            Goals{openGoals ? ` · ${openGoals}` : ""}
          </button>
          {role === "owner" && me.accounts && (
            <button type="button" className={shareOpen ? "on share-btn" : "secondary share-btn"} title="Share this canvas with someone" onClick={() => setShareOpen(!shareOpen)}>
              Share{members.length ? ` · ${members.length}` : ""}
            </button>
          )}
        </div>
      </div>
      {changes && changes.length > 0 && !reviewing && (
        <div className="banner changes-banner">
          {names(changes)} made {changes.length} change{changes.length > 1 ? "s" : ""} since you were last here.{" "}
          <button type="button" className="link" onClick={() => setReviewing(true)}>
            Go through them
          </button>{" "}
          <button type="button" className="link" onClick={doneReviewing}>
            Keep them all
          </button>
        </div>
      )}
      {trashedAt && (
        <div className="banner">
          This canvas is in the trash. Nothing on it is deleted.{" "}
          <button
            type="button"
            className="link"
            onClick={async () => {
              await canvasesApi.trash(canvasId, false);
              setTrashedAt(undefined);
            }}
          >
            Restore it
          </button>
        </div>
      )}
      {error && (
        <div className="banner fail" onClick={() => setError(null)}>
          {error} <span className="muted">(click to dismiss)</span>
        </div>
      )}
      <div
        ref={stageRef}
        className={`stage ${panning ? "mode-pan" : "mode-select"}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onWheel={onWheel}
        onPointerDown={onStagePointerDown}
        onPointerDownCapture={onStagePointerDownCapture}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
      >
        {offscreen.map((w) => (
          <button
            key={w.key}
            type="button"
            className="offscreen"
            style={w.style}
            title="Show it"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              if (w.id) return focusOn(w.id);
              const r = stageRef.current!.getBoundingClientRect();
              setView((v) => ({ ...v, x: r.width / 2 - (w.x + CARD_WIDTH / 2) * v.scale, y: 80 - w.y * v.scale }));
            }}
          >
            <span className="spinner" /> {w.dir} Explaining “{w.label.length > 32 ? `${w.label.slice(0, 32)}…` : w.label}”
          </button>
        ))}
        {loaded && shown.length === 0 && (
          // An empty canvas asks where to start, in the middle of the screen where the eye is.
          <div className="empty" data-pan="1">
            <h2 data-pan="1">What's confusing you?</h2>
            <StartBox onStart={startFrom} big />
            <p className="muted" data-pan="1">
              Paste the slide, the paper or the lecture link, or just type the words that lost you. Then drag a box over the
              part that made no sense.
            </p>
            <Examples onPick={tryExample} />
          </div>
        )}
        {/* Adding something new (a link, a PDF, a question) opens from the toolbar's Add, under it,
            and closes again once it's used or left. */}
        {loaded && shown.length > 0 && dockOpen && (
          <div className="start-dock">
            <StartBox onStart={startFrom} onClose={() => setDockOpen(false)} onArxiv={(q) => setArxivOpen(q)} />
          </div>
        )}
        <div
          className="world"
          // --zoom lets handles keep the same size on screen at any zoom.
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, ["--zoom" as string]: view.scale }}
        >
          {/* What others changed since you last looked, outlined in their colour until gone through. */}
          {(changes ?? []).map((c) => {
            const item = byId.get(c.id);
            if (!item || item.kind === "region" || c.what === "removed" || c.what === "goal") return null;
            const h = item.kind === "card" ? cardHeight(item) : item.kind === "note" ? (heights[item.id] ?? item.h ?? 70) : item.h;
            return (
              <div
                key={`${c.what}:${c.id}`}
                className="change-mark"
                style={{ left: item.x - 6, top: item.y - 6, width: item.w + 12, height: h + 12, ["--who" as string]: colourFor(c.by.id) }}
              >
                <span className="change-tag">
                  {c.by.name} {c.what === "added" ? "added this" : c.what === "moved" ? "moved this" : c.what === "restored" ? "put this back" : "changed this"}
                </span>
              </div>
            );
          })}
          <svg className="connectors">
            {connectors}
            {noteLines}
          </svg>
          {notes.map((n) => (
            <Note
              key={n.id}
              note={n}
              aboutName={n.on ? noteAboutName(byId.get(n.on.id)) : undefined}
              z={rank.get(n.id)}
              selected={selected === n.id || picked.has(n.id)}
              lit={hover === n.id || (!!n.on && hover === n.on.id)}
              moving={!!drag?.ids.includes(n.id)}
              onGrab={(e) => startMove(n.id, e)}
              onHover={(on) => setHover(on ? n.id : null)}
              onHeight={(h) => setHeights((all) => (all[n.id] === h ? all : { ...all, [n.id]: h }))}
              onSave={(text) => rewordNote(n, text)}
              onRemove={() => remove(n.id, "remove note")}
              onFocus={focusOn}
              history={() => api.noteHistory(n.id)}
            />
          ))}
          {noteDraft && (
            <Note
              key="note-draft"
              note={{ kind: "note", id: "draft", text: "", by: "you", at: new Date().toISOString(), x: noteDraft.x, y: noteDraft.y, w: NOTE_WIDTH, context: { via: "canvas", seq: 0 }, ...(noteDraft.on ? { on: noteDraft.on } : {}) }}
              editing
              selected={false}
              lit={false}
              moving={false}
              onGrab={() => {}}
              onHover={() => {}}
              onHeight={() => {}}
              onSave={saveNote}
              onCancel={() => setNoteDraft(null)}
              onRemove={() => setNoteDraft(null)}
              onFocus={focusOn}
              history={() => Promise.reject(new Error("not saved yet"))}
            />
          )}

          {images
            .filter((img) => img.video)
            .map((img) => (
              <VideoPlayer
                key={img.id}
                item={img}
                z={rank.get(img.id)}
                selected={selected === img.id || picked.has(img.id)}
                onStop={(t) => stopAt(img, t)}
                onNeedCopy={() => api.hostVideo(img.id).then(refresh, (e) => setError(`Couldn't fetch a copy of the video: ${e}`))}
                onResize={(e) => startVideoResize(img.id, e)}
                autoPlay={autoPlayId === img.id}
              />
            ))}
          {images
            .filter((img) => img.doc)
            .map((img) => (
              <PdfReader
                key={img.id}
                item={img}
                page={docPage(img.id)}
                zoom={view.scale}
                z={rank.get(img.id)}
                selected={selected === img.id || picked.has(img.id)}
                taken={new Set(images.filter((m) => m.pdf?.doc === img.id).map((m) => m.pdf!.page))}
                onPage={(n) => turnTo(img.id, n)}
                onTake={(n) => takePage(img, n)}
              />
            ))}
          {images.filter((img) => !img.video && !img.doc).map((img) => (
            <img
              key={img.id}
              ref={(el) => {
                imgRefs.current[img.id] = el;
              }}
              src={assetUrl(img.asset)}
              alt={img.name}
              draggable={false}
              data-image-id={img.id}
              className={`source-image ${selected === img.id || picked.has(img.id) ? "selected" : ""} ${link && link.from !== img.id ? "link-target" : ""}`}
              // A collapsed image stays loaded (retry reads its pixels) but out of view.
              style={{ left: img.x, top: img.y, width: img.w, height: img.h, display: img.collapsed ? "none" : undefined, zIndex: rank.get(img.id) }}
              onPointerDown={(e) => {
                // In pan mode the event bubbles to the stage, which pans.
                if (e.button !== 0 || panning) return;
                e.stopPropagation();
                const p = toWorld(e.clientX, e.clientY);
                setDraft({ imageId: img.id, start: p, end: p });
                stageRef.current?.setPointerCapture(e.pointerId);
              }}
            />
          ))}
          {images.filter((img) => img.pdf).map((img) => (
            <PdfPage
              key={`pdf-${img.id}`}
              img={img}
              zoom={view.scale}
              z={rank.get(img.id)}
              onSelectText={(text, rect) => setPdfSel(text && rect ? { imageId: img.id, text, rect } : null)}
            />
          ))}
          {images.map((img) => (
            <div
              key={`grip-${img.id}`}
              className="image-grip"
              data-image-id={img.id}
              // Same size on screen at any zoom: it's the only handle an image has.
              style={{
                left: img.x,
                top: img.y - GRIP / view.scale,
                width: img.w * view.scale,
                transform: `scale(${1 / view.scale})`,
                transformOrigin: "0 0",
                zIndex: rank.get(img.id),
              }}
              title="Drag to move this image with its boxes and explanations"
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                startMove(img.id, e);
              }}
            >
              <button
                type="button"
                className="fold-btn"
                aria-expanded={!img.collapsed}
                title={img.collapsed ? "Expand this image and its explanations" : "Collapse this image and everything on it"}
                onClick={() => toggleCollapse(img.id)}
              >
                {img.collapsed ? "▸" : "▾"}
              </button>
              <span aria-hidden>⠿</span>{" "}
              {img.doc ? (
                <a href={img.doc.url} target="_blank" rel="noreferrer" title={img.doc.title} onPointerDown={(e) => e.stopPropagation()}>
                  {img.doc.title} · {img.doc.pages} pages
                </a>
              ) : img.pdf?.doc && byId.has(img.pdf.doc) ? (
                // A page taken out is also a bookmark: it takes the PDF back to this page.
                <>
                  <button
                    type="button"
                    className="resume-btn"
                    title="Back to the PDF, open at this page"
                    onClick={() => {
                      turnTo(img.pdf!.doc!, img.pdf!.page);
                      focusOn(img.pdf!.doc!);
                    }}
                  >
                    ↩ p.{img.pdf.page}
                  </button>{" "}
                  {img.pdf.title}
                </>
              ) : img.pdf ? (
                <a href={`${img.pdf.url}#page=${img.pdf.page}`} target="_blank" rel="noreferrer" title={img.pdf.title} onPointerDown={(e) => e.stopPropagation()}>
                  p.{img.pdf.page} of {img.pdf.pages} · {img.pdf.title}
                </a>
              ) : img.source ? (
                <a href={img.source.url} target="_blank" rel="noreferrer" title={img.source.title} onPointerDown={(e) => e.stopPropagation()}>
                  arXiv {img.source.id} · p.{img.source.page} · {img.source.title}
                </a>
              ) : img.moment ? (
                // A moment is also a bookmark: ▶ takes the video back here.
                <>
                  <button type="button" className="resume-btn" title="Back to the video, playing from this moment" onClick={() => resume(img.moment!)}>
                    ▶ {clock(img.moment.t)}
                  </button>{" "}
                  {img.moment.title}
                </>
              ) : img.video ? (
                <a href={`https://www.youtube.com/watch?v=${img.video.videoId}`} target="_blank" rel="noreferrer" onPointerDown={(e) => e.stopPropagation()}>
                  ▶ {img.video.title}
                  {img.video.channel ? ` · ${img.video.channel}` : ""}
                </a>
              ) : (
                (img.topic ?? img.name)
              )}
              {img.collapsed && <span className="folded-count">{cardsBelow(img.id)} cards folded</span>}
            </div>
          ))}
          {/* The circle on a slide's right edge: drag it to another slide or a card to ask how they relate. */}
          {images.filter((img) => !img.collapsed).map((img) => (
            <div
              key={`port-${img.id}`}
              className="port image-port port-right"
              title="Drag to another slide or card to ask how they are related"
              // Centered on the edge point; drawn after the image at the same level, so on top of it.
              style={{ left: img.x + img.w, top: img.y + 28, zIndex: rank.get(img.id) }}
              onPointerDown={(e) => startLink(img.id, "right", e)}
            />
          ))}
          {images.filter((img) => !img.collapsed).map((img) => (
            <button
              key={`x-${img.id}`}
              type="button"
              className="remove-btn on-image"
              style={{ left: img.x + img.w - 30, top: img.y + 6, zIndex: rank.get(img.id) }}
              title="Remove this image and everything on it (Ctrl+Z brings it back)"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => remove(img.id, "remove image")}
            >
              ×
            </button>
          ))}

          {visibleRegions.map((r) => {
            const w = regionWorld(r);
            if (!w) return null;
            const card = cards.find((c) => c.parentId === r.id);
            const lit = hover === r.id || (card && hover === card.id);
            return (
              <div
                key={r.id}
                className={lit ? "region lit" : "region"}
                // Boxes stack with their image.
                style={{ left: w.x, top: w.y, width: w.w, height: w.h, zIndex: rank.get(r.imageId) }}
                onPointerEnter={() => setHover(r.id)}
                onPointerLeave={() => setHover(null)}
                onPointerDown={(e) => {
                  // A new box can start inside an earlier one.
                  if (e.button !== 0 || panning) return;
                  e.stopPropagation();
                  const p = toWorld(e.clientX, e.clientY);
                  setDraft({ imageId: r.imageId, start: p, end: p });
                  stageRef.current?.setPointerCapture(e.pointerId);
                }}
              >
                {lit && (
                  <button
                    type="button"
                    className="remove-btn on-region"
                    title="Remove this box and its explanations (Ctrl+Z brings it back)"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => remove(r.id, "remove box")}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          {marquee && (
            <div
              className="marquee"
              style={{
                left: Math.min(marquee.start.x, marquee.end.x),
                top: Math.min(marquee.start.y, marquee.end.y),
                width: Math.abs(marquee.end.x - marquee.start.x),
                height: Math.abs(marquee.end.y - marquee.start.y),
                borderWidth: 1.5 / view.scale,
              }}
            />
          )}
          {(link ?? relAsk?.line) && (
            <svg className="connectors link-preview">
              <path d={`M${(link ?? relAsk!.line).start.x} ${(link ?? relAsk!.line).start.y} L${(link ?? relAsk!.line).end.x} ${(link ?? relAsk!.line).end.y}`} className="connector relation lit" />
            </svg>
          )}

          {expected.map((p) => (
            <Fragment key={p.key}>
              {p.box && <div className="region sending" style={{ left: p.box.x, top: p.box.y, width: p.box.w, height: p.box.h, zIndex: 99999 }} />}
              <div className="ghost-card" style={{ left: p.x, top: p.y, width: CARD_WIDTH }}>
                <span className="spinner" />
                {p.text ?? (p.label ? <>Explaining “{p.label.length > 60 ? `${p.label.slice(0, 60)}…` : p.label}”…</> : "Reading the box you drew…")}
              </div>
            </Fragment>
          ))}

          {peek &&
            (() => {
              const img = byId.get(peek.imageId);
              if (img?.kind !== "image" || img.collapsed) return null;
              const k = img.w / img.naturalW;
              return (
                <div
                  className="region peek"
                  style={{ left: img.x + peek.rect.x * k, top: img.y + peek.rect.y * k, width: peek.rect.w * k, height: peek.rect.h * k, zIndex: 99999 }}
                />
              );
            })()}

          {draftRect && (
            // Above everything while drawing, or the image it's drawn on hides it.
            <div className="region drafting" style={{ left: draftRect.x, top: draftRect.y, width: draftRect.w, height: draftRect.h, zIndex: 99999 }} />
          )}

          {visibleCards.map((c) => (
            <Card
              key={c.id}
              card={c}
              foldedCount={c.collapsed ? cardsBelow(c.id) : 0}
              onToggleCollapse={() => toggleCollapse(c.id)}
              lit={hover === c.id || hover === c.parentId || goalLit.has(c.id)}
              onHover={(on) => setHover(on ? c.id : null)}
              onHeight={(h) => setHeights((all) => (all[c.id] === h ? all : { ...all, [c.id]: h }))}
              onDescend={(text, context, clientY) => descend(c, text, context, toWorld(0, clientY).y)}
              onRetry={() => retry(c)}
              onAnswer={(text) => answer(c, text)}
              onFocus={focusOn}
              onObjectBack={() => api.objectBack(c.id).then(refresh, (e) => setError(`Couldn't bring that back: ${e}`))}
              onAddPaper={(paper) => addPaperPages(paper, "1-2", { x: c.x + c.w + GAP, y: c.y })}
              onAddLink={(url) => startFrom(url, { x: c.x + c.w + GAP, y: slotY(c.x + c.w + GAP, c.y) }).then(() => {})}
              onPlayVideo={(videoId, url) => playOnCanvas(c, videoId, url)}
              onPlaceImage={async (asset, name) => {
                const blob = await fetch(assetUrl(asset)).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))));
                const x = c.x + c.w + GAP;
                await placeImage(new File([blob], name.slice(0, 80) || "picture", { type: blob.type }), { x, y: slotY(x, c.y) });
              }}
              onOpenNotebook={() => setNotebook({ id: c.id, autoRun: false })}
              onAsk={async (text) => {
                try {
                  await api.chat(c.id, text);
                  await refresh();
                } catch (e) {
                  setError(`Couldn't send: ${e}`);
                }
              }}
              onGrab={(e) => startMove(c.id, e)}
              onResize={(e) => startResize(c.id, e)}
              resizeArmed={resizeArmed === c.id}
              onPortDown={(side, e) => startLink(c.id, side, e)}
              onBookmark={() => bookmark(c)}
              linking={!!link && link.from !== c.id}
              relatesNames={c.relates?.map((id) => {
                const s = byId.get(id);
                return s?.kind === "card" ? (s.subject ?? "this") : s?.kind === "image" ? (s.topic ?? s.name) : "a removed card";
              })}
              moving={drag?.ids.includes(c.id) ?? false}
              z={rank.get(c.id) ?? 0}
              selected={selected === c.id || picked.has(c.id)}
              lookImage={c.lookImage ? (byId.get(c.lookImage) as ImageItem | undefined) : undefined}
              onPeek={setPeek}
              onGrow={(r) => api.extend(c.id, r).then(({ ext }) => (grewStep(c.id, ext.id), refresh()), (e) => setError(`Couldn't grow that: ${e}`))}
              onUngrow={(extId) => api.unextend(c.id, extId).then(({ taken }) => (ungrewStep(c.id, extId, taken), refresh()), (e) => setError(`Couldn't take that away: ${e}`))}
              explained={explainedIn.get(c.id) ?? NONE}
              explaining={explainingIn.get(c.id) ?? NONE}
              childStages={childStages.get(c.id) ?? NO_STAGES}
              onRemove={() => remove(c.id, `remove “${(c.subject ?? "card").slice(0, 30)}”`)}
            />
          ))}
        </div>
      </div>
      {pdfSel && (
        <button
          type="button"
          className="descend pdf-explain"
          style={{ left: pdfSel.rect.left, top: pdfSel.rect.bottom + 8 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const img = byId.get(pdfSel.imageId);
            const s = pdfSel;
            setPdfSel(null);
            window.getSelection()?.removeAllRanges();
            if (img?.kind !== "image") return;
            const a = toWorld(s.rect.left, s.rect.top);
            const b = toWorld(s.rect.right, s.rect.bottom);
            void explainArea(img, { x0: a.x - 4, y0: a.y - 4, x1: b.x + 4, y1: b.y + 4 }, s.text);
          }}
        >
          Explain “{pdfSel.text.length > 60 ? `${pdfSel.text.slice(0, 60)}…` : pdfSel.text}”
        </button>
      )}
      {notebook && byId.get(notebook.id)?.kind === "card" && (
        <NotebookPanel
          card={byId.get(notebook.id) as CardItem}
          autoRun={notebook.autoRun}
          onSave={(cells) => api.saveNotebook(notebook.id, cells)}
          onShowCard={() => focusOn(notebook.id)}
          onClose={() => setNotebook(null)}
        />
      )}
      {calling && <CallBar canvasId={canvasId} serverVoice={!!me.speech?.tts} serverEars={!!me.speech?.stt}
          onChanged={(removed) => {
            if (removed?.length) pushStep({ label: "remove (on the call)", undo: () => api.show(removed), redo: () => api.hide(removed) });
            void refresh();
          }} onOpened={(id) => {
            setFocusNext(id);
            void refresh();
          }} onClose={() => setCalling(false)} />}
      {reviewing && changes && (
        <ChangesPanel
          changes={changes}
          onShow={(c) => focusOn(c.id)}
          onUndo={undoChange}
          onKeep={keepChange}
          onDone={doneReviewing}
        />
      )}
      {picked.size > 0 && (
        <div className="picked-bar" role="toolbar">
          <span>
            {picked.size} selected <span className="muted small">· Shift-drag to add more</span>
          </span>
          <button type="button" className="danger" onClick={deletePicked} title="Delete them and what hangs off them (Delete). Undo brings them back.">
            Delete
          </button>
          <button type="button" className="link" onClick={() => setPicked(new Set())}>
            Cancel
          </button>
        </div>
      )}
      {relAsk && <RelationMenu at={relAsk} onPick={relateAs} onCancel={() => setRelAsk(null)} />}
      {shareOpen && (
        <ShareDialog
          name={name}
          links={links}
          members={members}
          onAddLink={async (r) => {
            await api.addLink(r);
            await refresh();
          }}
          onRemoveLink={async (t) => {
            await api.removeLink(t);
            await refresh();
          }}
          onRemoveMember={async (id) => {
            await api.removeMember(id);
            await refresh();
          }}
          onClose={() => setShareOpen(false)}
        />
      )}
      {goalsOpen && (
        <GoalsPanel
          goals={goals}
          cards={cardsById}
          current={currentGoal}
          onAdd={(text, parentId) =>
            api.addGoal(text, parentId).then(({ goal }) => {
              pushStep({ label: "add a goal", undo: () => api.changeGoal(goal.id, { status: "dropped" }), redo: () => api.changeGoal(goal.id, { status: "open" }) });
              return refresh();
            }, (e) => setError(`Couldn't add that goal: ${e}`))
          }
          onChange={(goal, change) =>
            api.changeGoal(goal.id, change).then(({ goal: now }) => {
              pushStep({ label: change.text ? "reword a goal" : change.status ? `mark a goal ${change.status}` : "move a goal", undo: () => api.changeGoal(goal.id, { restore: goal }), redo: () => api.changeGoal(goal.id, { restore: now }) });
              return refresh();
            }, (e) => setError(`Couldn't change that goal: ${e}`))
          }
          onReExplain={(goal) =>
            api.reExplain(goal.id).then(({ ids }) => {
              const swap = () => Promise.all(ids.map((id) => api.swapExplanation(id)));
              pushStep({ label: `re-explain ${ids.length === 1 ? "a card" : `${ids.length} cards`}`, undo: swap, redo: swap });
              return refresh();
            }, (e) => setError(`Couldn't re-explain them: ${e}`))
          }
          onFocus={focusOn}
          onLight={(ids) => setGoalLit(new Set(ids))}
          onClose={() => {
            setGoalsOpen(false);
            setGoalLit(new Set());
            try {
              localStorage.setItem("librarian.goalsOpen", "0");
            } catch {}
          }}
        />
      )}
      {arxivOpen !== false && <ArxivPanel initial={arxivOpen} onAdd={(paper, pages) => addPaperPages(paper, pages)} onClose={() => setArxivOpen(false)} />}
    </div>
  );
}

/** Builds the two images the model reads: the page with the box drawn on it, and the box enlarged. */
function renderRegion(img: HTMLImageElement, rect: Rect): { marked: string; crop: string } {
  const page = document.createElement("canvas");
  const k = Math.min(1, 1280 / img.naturalWidth);
  page.width = Math.round(img.naturalWidth * k);
  page.height = Math.round(img.naturalHeight * k);
  const pc = page.getContext("2d")!;
  pc.drawImage(img, 0, 0, page.width, page.height);
  pc.strokeStyle = "#e01e1e";
  pc.lineWidth = Math.max(3, Math.round(page.width / 300));
  pc.strokeRect(rect.x * k, rect.y * k, rect.w * k, rect.h * k);

  const crop = document.createElement("canvas");
  // Enlarge small selections so the model can read them.
  const up = Math.min(4, Math.max(1, 768 / Math.max(rect.w, rect.h)));
  crop.width = Math.round(rect.w * up);
  crop.height = Math.round(rect.h * up);
  const cc = crop.getContext("2d")!;
  cc.imageSmoothingQuality = "high";
  cc.fillStyle = "#fff";
  cc.fillRect(0, 0, crop.width, crop.height);
  cc.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, crop.width, crop.height);

  return { marked: page.toDataURL("image/jpeg", 0.88), crop: crop.toDataURL("image/png") };
}

/** The canvas's name, edited in place: click it, type, press Enter or click away. */
/** What a note is about, by name, for its "on …" line. */
function noteAboutName(i: Item | undefined): string | undefined {
  if (!i) return undefined;
  const t = i.kind === "card" ? (i.subject ?? i.selection ?? i.request ?? i.origin?.title) : i.kind === "image" ? (i.video?.title ?? i.moment?.title ?? i.pdf?.title ?? i.topic ?? i.name) : undefined;
  if (!t) return undefined;
  const one = t.replace(/\s+/g, " ").trim();
  return `“${one.length > 40 ? `${one.slice(0, 39)}…` : one}”`;
}

function CanvasName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (!editing)
    return (
      <button
        type="button"
        className="canvas-name"
        title="Rename this canvas (its URL stays the same)"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        {name || "…"}
      </button>
    );
  const done = () => {
    setEditing(false);
    onRename(draft);
  };
  return (
    <input
      className="canvas-name-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") done();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

/** Jump to another canvas, start a new one, or go to the list, without leaving the toolbar. */
function CanvasSwitcher({ currentId }: { currentId: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CanvasSummary[] | null>(null);
  useEffect(() => {
    if (!open) return;
    canvasesApi.list().then(setList, () => setList([]));
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".switcher")) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const others = (list ?? []).filter((c) => !c.trashedAt && c.id !== currentId);
  return (
    <div className="switcher">
      <button type="button" className="link switcher-toggle" title="Switch canvas" aria-expanded={open} onClick={() => setOpen(!open)}>
        ▾
      </button>
      {open && (
        <div className="switcher-menu" role="menu">
          {list === null ? (
            <p className="muted small">Loading…</p>
          ) : (
            others.slice(0, 12).map((c) => (
              <a key={c.id} role="menuitem" {...linkTo(`/c/${c.id}`)} className="switcher-item" onClick={(e) => (linkTo(`/c/${c.id}`).onClick(e), setOpen(false))}>
                <span>{c.name}</span>
                <span className="muted small">{ago(c.updatedAt)}</span>
              </a>
            ))
          )}
          {list && others.length === 0 && <p className="muted small">No other canvases yet.</p>}
          <hr />
          <button
            type="button"
            role="menuitem"
            className="link switcher-item"
            onClick={async () => {
              const c = await canvasesApi.create("");
              navigate(`/c/${c.id}`);
            }}
          >
            + New canvas
          </button>
          <a role="menuitem" {...linkTo("/")} className="switcher-item">
            All canvases
          </a>
          <hr />
          <button
            type="button"
            role="menuitem"
            className="link switcher-item danger"
            onClick={async () => {
              const name = (list ?? []).find((c) => c.id === currentId)?.name ?? "this canvas";
              if (!window.confirm(`Delete “${name}” for good? Everything on it is erased, and this can't be undone.`)) return;
              await canvasesApi.remove(currentId);
              navigate("/");
            }}
          >
            Delete this canvas
          </button>
        </div>
      )}
    </div>
  );
}

const typedKey = (canvasId: string) => `librarian.start.${canvasId}`;
/** Hands what was typed on the home page to the canvas made for it. */
export function giveTypedStart(canvasId: string, input: string) {
  try {
    sessionStorage.setItem(typedKey(canvasId), input);
  } catch {}
}
function takeTypedStart(canvasId: string): string | null {
  try {
    const v = sessionStorage.getItem(typedKey(canvasId));
    sessionStorage.removeItem(typedKey(canvasId));
    return v;
  } catch {
    return null;
  }
}

/** A link to read or a question to explain: a start that isn't an image. */
export function StartBox({ onStart, big = false, onClose, onArxiv }: { onStart: (input: string) => Promise<unknown>; big?: boolean; onClose?: () => void; onArxiv?: (query: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={big ? "start-box big" : "start-box"}
      onPointerDown={(e) => e.stopPropagation()}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim() || busy) return;
        setBusy(true);
        await onStart(value.trim());
        setBusy(false);
        setValue("");
        onClose?.();
      }}
    >
      <input
        value={value}
        disabled={busy}
        autoFocus={big || Boolean(onClose)}
        onKeyDown={(e) => e.key === "Escape" && onClose?.()}
        onBlur={() => !value.trim() && !busy && onClose?.()}
        placeholder={big ? "A link to read, or a question to explain…" : "Paste a link (a page, a PDF, a video) or type a question… or drop an image anywhere"}
        title="Paste a link (e.g. a Wikipedia page) to read it here, or type a question to have it explained"
        onChange={(e) => setValue(e.target.value)}
      />
      {onArxiv && (
        <button
          type="button"
          className="start-arxiv"
          // Pressing it mustn't blur the box first, which would close it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onArxiv(/^https?:\/\//.test(value.trim()) ? "" : value.trim());
            setValue("");
            onClose?.();
          }}
          title="Search arXiv for papers, then add the pages you want"
        >
          {value.trim() && !/^https?:\/\//.test(value.trim()) ? `Search arXiv for “${value.trim().slice(0, 40)}”` : "Search arXiv for papers"}
        </button>
      )}
    </form>
  );
}

/** One-click starting points, for a first visit. */
export function Examples({ onPick }: { onPick: (ex: Example) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="examples">
      <span className="muted small">Or try an example:</span>
      {EXAMPLES.map((ex) => (
        <button
          key={ex.key}
          type="button"
          className="example"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(ex.key);
            try {
              await onPick(ex);
            } finally {
              setBusy(null);
            }
          }}
        >
          <span className="example-kind">{ex.kind}</span>
          <span className="example-title">{busy === ex.key ? "Starting…" : ex.title}</span>
        </button>
      ))}
    </div>
  );
}

/** Where a connection was dropped: what the reader wants to know about the two things. */
function RelationMenu({ at, onPick, onCancel }: { at: { left: number; top: number }; onPick: (kind: RelationKind) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCancel();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    ref.current?.querySelector("button")?.focus();
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onCancel]);
  // Beside the drop point, kept on screen.
  const W = 260;
  const H = 44 * RELATION_KINDS.length + 52;
  const left = Math.max(8, Math.min(at.left + 12, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(at.top - 20, window.innerHeight - H - 8));
  return (
    <div ref={ref} className="relation-menu" role="menu" style={{ left, top, width: W }}>
      {RELATION_KINDS.map((k) => (
        <button key={k} type="button" role="menuitem" className={`relation-choice rel-${k}`} onClick={() => onPick(k)}>
          <svg className="relation-swatch" viewBox="0 0 28 12" aria-hidden="true">
            <RelationSample kind={k} />
          </svg>
          {RELATION_ASK[k]}
        </button>
      ))}
      <button type="button" className="link small relation-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** A short run of each kind's line, as the menu shows it beside its question. */
function RelationSample({ kind }: { kind: RelationKind }) {
  const cls = `connector relation rel-${kind}`;
  if (kind === "differs")
    return (
      <>
        <path d="M2 6 H26" className={cls} />
        <path d="M2 6 H26" className="connector rel-differs-gap" />
      </>
    );
  if (kind === "disputes")
    return (
      <>
        <path d="M2 6 H24" className={cls} />
        <path d="M24 1 V11" className={`${cls} rel-mark`} />
      </>
    );
  if (kind === "leads")
    return (
      <>
        <path d="M2 6 H20" className={cls} />
        <path d="M19 2 L26 6 L19 10 Z" className={`rel-head rel-${kind}`} />
      </>
    );
  if (kind === "within")
    return (
      <>
        <path d="M2 6 H19" className={cls} />
        <path d="M19 2 L26 6 L19 10 Z" className={`rel-head hollow rel-${kind}`} />
      </>
    );
  return <path d="M2 6 H26" className={cls} />;
}

// ---- Relation connectors: semshapes runs between boxes ----

type RBox = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
/** A routed connector: its path, where it ends, and the way it is travelling there. */
type Routed = { d: string; end: Pt; dir: Pt };

/**
 * Where a connector meets the card: its top when the thing is above it, its bottom when below,
 * at `at` of its width. `dir` is the way the line travels into it (1 down, -1 up).
 */
function relEntry(card: RBox, from: RBox, at = 0.5): Pt & { dir: number } {
  const x = card.x + card.w * at;
  return from.y + from.h / 2 <= card.y + card.h / 2 ? { x, y: card.y, dir: 1 } : { x, y: card.y + card.h, dir: -1 };
}

/** Straight runs with 45° corners: out of a box vertically, across, and into `to` vertically. */
function relRoute(from: RBox, to: Pt, level = 0.5): Routed {
  const down = to.y >= from.y + from.h / 2;
  const p = { x: from.x + from.w / 2, y: down ? from.y + from.h : from.y };
  const dir = down ? 1 : -1;
  const m = p.y + (to.y - p.y) * level;
  const dx = to.x - p.x;
  if (Math.abs(dx) < 2) return { d: `M${p.x} ${p.y} V${to.y}`, end: to, dir: { x: 0, y: dir } };
  const sx = Math.sign(dx);
  const r = Math.min(14, Math.abs(dx) / 2, Math.abs(m - p.y), Math.abs(to.y - m));
  return { d: `M${p.x} ${p.y} V${m - dir * r} L${p.x + sx * r} ${m} H${to.x - sx * r} L${to.x} ${m + dir * r} V${to.y}`, end: to, dir: { x: 0, y: dir } };
}

/** Out of the card's side toward a box, across, and into the box from below (or above). */
function relRouteOut(card: RBox, to: RBox): Routed {
  const tx = to.x + to.w / 2;
  const right = tx > card.x + card.w / 2;
  const p = { x: right ? card.x + card.w : card.x, y: card.y + 48 };
  const above = to.y + to.h <= p.y;
  const ty = above ? to.y + to.h : to.y;
  const dir = above ? -1 : 1;
  const sx = right ? 1 : -1;
  if ((tx - p.x) * sx < 16) {
    // The box is straight over the card's edge: up (or down) and in.
    return { d: `M${p.x} ${p.y} H${p.x + sx * 16} V${ty}`, end: { x: p.x + sx * 16, y: ty }, dir: { x: 0, y: dir } };
  }
  const r = Math.min(14, Math.abs(tx - p.x) / 2, Math.abs(ty - p.y) / 2);
  return { d: `M${p.x} ${p.y} H${tx - sx * r} L${tx} ${p.y + dir * r} V${ty}`, end: { x: tx, y: ty }, dir: { x: 0, y: dir } };
}

/** A connector's head at `p`, travelling `dir`: an arrow, a bar across it, or a hollow triangle. */
function relHead(p: Pt, dir: Pt, kind: "arrow" | "bar" | "hollow"): string {
  const L = 11;
  const W = 6;
  const bx = p.x - dir.x * L;
  const by = p.y - dir.y * L;
  const nx = -dir.y;
  const ny = dir.x;
  if (kind === "bar") return `M${p.x + nx * 9} ${p.y + ny * 9} L${p.x - nx * 9} ${p.y - ny * 9}`;
  return `M${bx + nx * W} ${by + ny * W} L${p.x} ${p.y} L${bx - nx * W} ${by - ny * W} Z`;
}

/** The toolbar's list of bookmarked cards: pick one to go to it. */
function Bookmarks({ cards, onShow }: { cards: CardItem[]; onShow: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div className="bookmarks" ref={ref}>
      <button type="button" className={open ? "on" : "secondary"} aria-expanded={open} title="Cards you bookmarked" onClick={() => setOpen(!open)}>
        Bookmarks · {cards.length}
      </button>
      {open && (
        <div className="switcher-menu bookmarks-menu" role="menu">
          {cards.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className="link switcher-item"
              onClick={() => {
                setOpen(false);
                onShow(c.id);
              }}
            >
              <span>{c.subject ?? c.selection ?? "A card"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

