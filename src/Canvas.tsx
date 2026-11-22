import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CARD_WIDTH, type CanvasSummary, type CardItem, type ImageItem, type Item, MIN_CHILD_GAP, type Paper, type Rect, type RegionItem } from "../shared/canvas.ts";
import { Card, type Side } from "./Card.tsx";
import { assetUrl, CanvasNotFound, canvasApi, canvasesApi } from "./canvasApi.ts";
import { renderPages as renderPaperPages } from "./arxiv.ts";
import { ArxivPanel } from "./ArxivPanel.tsx";
import { EXAMPLES, type Example, exampleByKey, runExample } from "./examples.ts";
import { ago } from "./Home.tsx";
import { linkTo, navigate } from "./router.ts";
import { useIsAdmin, useIsAnonymous } from "./session.ts";

interface View {
  x: number;
  y: number;
  scale: number;
}

const GAP = 64; // horizontal gap between a source and its explanations
const STACK_GAP = 24; // vertical gap between cards in one column
const PENDING_HEIGHT = 900; // space reserved for a card that hasn't been written yet; diagram cards run 700-1100px
const MAX_IMAGE_WIDTH = 900;

// Where you were looking is remembered per canvas, in this browser only.
function loadView(canvasId: string): View {
  try {
    const v = JSON.parse(localStorage.getItem(`librarian.view.${canvasId}`) ?? "");
    if (typeof v?.x === "number" && typeof v?.scale === "number") return v;
  } catch {}
  return { x: 40, y: 80, scale: 1 };
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
  const api = useMemo(() => canvasApi(canvasId), [canvasId]);
  const [name, setName] = useState("");
  const [trashedAt, setTrashedAt] = useState<string | undefined>();
  const [notFound, setNotFound] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => loadView(canvasId));
  const [draft, setDraft] = useState<{ imageId: string; start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  // A container being dragged, with everything that hangs off it.
  // A connection being dragged from one card's port, to ask how it relates to another card.
  const [link, setLink] = useState<{ from: string; side: Side; start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
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
  const [heights, setHeights] = useState<Record<string, number>>({});
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
      // Hidden items stay in the log (undo can bring them back) but aren't drawn or laid out around.
      setItems(s.items.filter((i) => !i.hidden));
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
  const pending = items.some((i) => i.kind === "card" && (isPending(i) || i.chatPending));
  // While a diagram is being drawn, poll fast enough to watch it appear.
  const drawing = items.some((i) => i.kind === "card" && i.objectKind === "diagram" && isPending(i));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refresh, drawing ? 350 : 1000);
    return () => clearInterval(t);
  }, [pending, drawing, refresh]);

  useEffect(() => saveView(canvasId, view), [canvasId, view]);

  useEffect(() => {
    document.title = name ? `${name} · Librarian` : "Librarian";
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

  /**
   * First free y at or below `wanted` for a new card at x. The new card is assumed to be as tall
   * as the reserve, since it hasn't been written yet. Placement is decided once and never revisited.
   */
  const slotY = (x: number, wanted: number) => {
    let y = wanted;
    const column = cards
      .filter((c) => c.x < x + CARD_WIDTH && x < c.x + c.w)
      .sort((a, b) => a.y - b.y);
    let moved = true;
    while (moved) {
      moved = false;
      for (const c of column) {
        const bottom = c.y + cardHeight(c);
        if (y < bottom + STACK_GAP && y + PENDING_HEIGHT > c.y - STACK_GAP) {
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
  const startFrom = async (input: string) => {
    const r = stageRef.current!.getBoundingClientRect();
    const right = Math.max(0, ...shown.filter((i) => i.kind !== "region").map((i) => i.x + i.w));
    const x = shown.length ? right + 120 : 40;
    const y = Math.round(toWorld(r.left, r.top + 60).y);
    try {
      const res = await api.addSource(input, x, y);
      added("start from", [res.card.id]);
      await refresh();
      setView((v) => ({ ...v, x: r.width * 0.06 - x * v.scale, y: 60 - y * v.scale }));
      setSelected(res.card.id);
    } catch (e) {
      setError(`Couldn't start from that: ${e}`);
    }
  };

  // ---- Papers from arXiv ----

  const [arxivOpen, setArxivOpen] = useState(false);

  /**
   * Renders the chosen pages of a paper and lays them side by side, starting at `at` (or near the
   * middle of the view). One step to undo, however many pages.
   */
  const tryExample = async (ex: Example) => {
    try {
      await runExample(ex, startFrom, (paper, pages) => addPaperPages(paper, pages));
    } catch (e) {
      setError(`Couldn't start the example: ${e}`);
    }
  };

  // A canvas made from an example on the home page (/c/<id>?example=<key>) starts it once, when empty.
  const exampleStarted = useRef(false);
  useEffect(() => {
    if (!loaded || exampleStarted.current) return;
    exampleStarted.current = true;
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
        const scale = Math.min(3, Math.max(0.15, v.scale * Math.exp(-e.deltaY * 0.0025)));
        return { scale, x: px - ((px - v.x) * scale) / v.scale, y: py - ((py - v.y) * scale) / v.scale };
      });
    } else {
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  };

  // Ctrl+wheel must not zoom the whole browser page.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => (e.ctrlKey || e.metaKey) && e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  // Pan mode (or Space, or the middle button) drags from anywhere; select mode only from empty canvas.
  const onStagePointerDown = (e: React.PointerEvent) => {
    const onBackground = e.target === e.currentTarget || Boolean((e.target as HTMLElement).dataset.pan);
    const isButton = (e.target as HTMLElement).closest("button, a");
    if (!(panning || e.button === 1 || (onBackground && e.button === 0)) || (isButton && !panning)) return;
    e.preventDefault();
    if (onBackground) setSelected(null);
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
        const parent = i.kind === "region" ? i.imageId : i.kind === "card" ? i.parentId : undefined;
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
    if (parent?.kind === "card") return { left: parent.x, right: parent.x + parent.w, top: parent.y, bottom: parent.y + cardHeight(parent) };
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
    if (i?.kind === "card") return { x: i.x, y: i.y, w: i.w, h: cardHeight(i) };
    if (i?.kind === "image") return i.collapsed ? { x: i.x, y: i.y - 26, w: i.w, h: 22 } : { x: i.x, y: i.y, w: i.w, h: i.h };
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
    try {
      const res = await api.relate({ a: aId, b: bId, x, y });
      added("relate", [res.card.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't ask how they relate: ${e}`);
    }
  };

  const onStagePointerMove = (e: React.PointerEvent) => {
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
    if (link) return finishLink(link, e.clientX, e.clientY);
    if (drag) return finishMove(drag);
    if (!draft) return;
    const d = draft;
    setDraft(null);
    const img = byId.get(d.imageId);
    if (img?.kind !== "image") return;
    // Clamp to the image, then convert to the image's natural pixels.
    const x0 = Math.max(img.x, Math.min(d.start.x, d.end.x));
    const y0 = Math.max(img.y, Math.min(d.start.y, d.end.y));
    const x1 = Math.min(img.x + img.w, Math.max(d.start.x, d.end.x));
    const y1 = Math.min(img.y + img.h, Math.max(d.start.y, d.end.y));
    if (x1 - x0 < 8 || y1 - y0 < 8) return;
    const k = img.naturalW / img.w;
    const rect = { x: Math.round((x0 - img.x) * k), y: Math.round((y0 - img.y) * k), w: Math.round((x1 - x0) * k), h: Math.round((y1 - y0) * k) };
    const el = imgRefs.current[img.id];
    if (!el) return;
    try {
      const { marked, crop } = renderRegion(el, rect);
      const cardX = img.x + img.w + GAP;
      const res = await api.addRegion({ imageId: img.id, rect, card: { x: cardX, y: slotY(cardX, Math.round(y0)) }, marked, crop });
      added("box", [res.region.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't send the selection: ${e}`);
    }
  };

  // ---- Descending from a card ----

  const descend = async (parent: CardItem, selection: string, context: string, worldY: number) => {
    // Grow the same way as the branch: a card put left of, above or below its source sends its
    // own descents further that way.
    const dir = dirOf(parent);
    const x = dir === "left" ? parent.x - GAP - CARD_WIDTH : dir === "right" ? parent.x + parent.w + GAP : parent.x;
    const vertical = dir === "below" ? parent.y + cardHeight(parent) + STACK_GAP * 2 : dir === "above" ? parent.y - STACK_GAP * 2 - PENDING_HEIGHT : null;
    try {
      const y = vertical === null ? slotY(x, Math.round(worldY - 20)) : dir === "below" ? slotY(x, Math.round(vertical)) : Math.round(vertical);
      const res = await api.descend({ parentId: parent.id, selection, context, x, y });
      added(`explain “${selection.slice(0, 30)}”`, [res.card.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't go further down: ${e}`);
    }
  };

  const answer = async (card: CardItem, text: string) => {
    try {
      await api.answer(card.id, text);
      await refresh();
    } catch (e) {
      setError(`Couldn't send your answer: ${e}`);
    }
  };

  const retry = async (card: CardItem) => {
    try {
      const parent = byId.get(card.parentId);
      if (parent?.kind === "region") {
        const el = imgRefs.current[parent.imageId];
        if (!el) throw new Error("its image isn't on the canvas");
        await api.retry(card.id, renderRegion(el, parent.rect));
      } else {
        await api.retry(card.id);
      }
      await refresh();
    } catch (e) {
      setError(`Couldn't retry: ${e}`);
    }
  };

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
  const cardsBelow = (id: string) => subtree(id).filter((d) => d !== id && byId.get(d)?.kind === "card").length;

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
  const focusOn = (id: string) => {
    const item = byId.get(id);
    const el = stageRef.current;
    if (!item || item.kind === "region" || !el) return;
    const r = el.getBoundingClientRect();
    setView((v) => ({ ...v, x: r.width / 2 - (item.x + item.w / 2) * v.scale, y: 80 - item.y * v.scale }));
    setSelected(id);
  };

  // ---- Connectors ----

  const connectors = visibleCards.flatMap((c) => {
    // A relation hangs from both things it relates: a dashed line from the bottom of each.
    if (c.relates) {
      return c.relates.flatMap((id, i) => {
        const s = byId.get(id);
        const box = relBox(id);
        if (!s || !box || folded.has(id)) return [];
        const from = { x: box.x + box.w / 2, y: box.y + box.h };
        const to = { x: c.x + c.w / 2 + (i === 0 ? -40 : 40), y: c.y };
        const my = (from.y + to.y) / 2;
        const lit = hover === c.id || hover === id;
        return [
          <path
            key={`${c.id}-${i}`}
            d={`M${from.x} ${from.y} C${from.x} ${my} ${to.x} ${my} ${to.x} ${to.y}`}
            className={lit ? "connector relation lit" : "connector relation"}
          />,
        ];
      });
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
      const to = { x: c.x + c.w / 2, y: dir === "below" ? c.y : c.y + cardHeight(c) };
      const my = (from.y + to.y) / 2;
      d = `M${from.x} ${from.y} C${from.x} ${my} ${to.x} ${my} ${to.x} ${to.y}`;
    }
    return [<path key={c.id} d={d} className={lit ? "connector lit" : "connector"} />];
  });

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
          Librarian
        </a>
        <span className="muted">/</span>
        <CanvasName name={name} onRename={rename} />
        <CanvasSwitcher currentId={canvasId} />
        {anonymous && (
          <a {...linkTo("/signin")} className="save-link" title="Not signed in: sign in to keep this canvas">
            Sign in to save
          </a>
        )}
        <span className="muted small hint">
          Drop or paste an image · Select: drag a box over what stopped you · hold Space to pan · Ctrl+scroll to zoom
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="secondary untangle"
          title="Push overlapping cards down so nothing overlaps (Ctrl+Z undoes it)"
          onClick={untangle}
        >
          Untangle
        </button>
        <button type="button" className="secondary untangle" title="Search arXiv and add pages of a paper" onClick={() => setArxivOpen(true)}>
          arXiv
        </button>
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
        <div className="history">
          <button type="button" className="secondary" disabled={!nextUndo} title={nextUndo ? `Undo ${nextUndo.label} (Ctrl+Z)` : "Nothing to undo"} onClick={undo}>
            ↶ Undo
          </button>
          <button type="button" className="secondary" disabled={!nextRedo} title={nextRedo ? `Redo ${nextRedo.label} (Ctrl+Shift+Z)` : "Nothing to redo"} onClick={redo}>
            ↷ Redo
          </button>
        </div>
        <div className="modes" role="radiogroup" aria-label="Canvas tool">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "select"}
            className={mode === "select" ? "on" : ""}
            title="Select (V): drag a box on an image to explain it, select words in a card to go further down"
            onClick={() => setMode("select")}
          >
            <span aria-hidden>⬚</span> Select <kbd>V</kbd>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "pan"}
            className={mode === "pan" ? "on" : ""}
            title="Pan (H): drag anywhere to move around. Hold Space for a moment of panning in either mode."
            onClick={() => setMode("pan")}
          >
            <span aria-hidden>✥</span> Pan <kbd>H</kbd>
          </button>
        </div>
        <button type="button" className="link" title="Reset zoom" onClick={() => setView({ x: 40, y: 80, scale: 1 })}>
          {Math.round(view.scale * 100)}%
        </button>
        {admin && <a {...linkTo("/settings")}>Settings</a>}
      </div>
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
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
      >
        {loaded && shown.length === 0 && (
          // An empty canvas asks where to start, in the middle of the screen where the eye is.
          <div className="empty" data-pan="1">
            <h2 data-pan="1">What stopped you?</h2>
            <StartBox onStart={startFrom} big />
            <p className="muted" data-pan="1">
              Paste a link (a Wikipedia page, an article) or type a question. Or drop or paste an image of a slide, a page or a
              screenshot, then drag a box over the part you want explained.
            </p>
            <Examples onPick={tryExample} />
          </div>
        )}
        {/* On a canvas with things on it, starting points live in a bar that stays at the bottom. */}
        {loaded && shown.length > 0 && (
          <div className="start-dock">
            <StartBox onStart={startFrom} />
          </div>
        )}
        <div
          className="world"
          // --zoom lets handles keep the same size on screen at any zoom.
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, ["--zoom" as string]: view.scale }}
        >
          <svg className="connectors">{connectors}</svg>

          {images.map((img) => (
            <img
              key={img.id}
              ref={(el) => {
                imgRefs.current[img.id] = el;
              }}
              src={assetUrl(img.asset)}
              alt={img.name}
              draggable={false}
              data-image-id={img.id}
              className={`source-image ${selected === img.id ? "selected" : ""} ${link && link.from !== img.id ? "link-target" : ""}`}
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
          {images.map((img) => (
            <div
              key={`grip-${img.id}`}
              className="image-grip"
              data-image-id={img.id}
              style={{ left: img.x, top: img.y - 26, width: img.w, zIndex: rank.get(img.id) }}
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
              {img.source ? (
                <a href={img.source.url} target="_blank" rel="noreferrer" title={img.source.title} onPointerDown={(e) => e.stopPropagation()}>
                  arXiv {img.source.id} · p.{img.source.page} · {img.source.title}
                </a>
              ) : (
                (img.topic ?? img.name)
              )}
              {img.collapsed && <span className="folded-count">{cardsBelow(img.id)} cards folded</span>}
            </div>
          ))}
          {/* Ports on a slide: drag from one to another slide or a card to ask how they relate. */}
          {images.filter((img) => !img.collapsed).flatMap((img) =>
            (["left", "right", "top", "bottom"] as const).map((side) => (
              <div
                key={`port-${img.id}-${side}`}
                className={`port image-port port-${side}`}
                title="Drag to another slide or card to ask how they are related"
                // Centered on the edge point; drawn after the image at the same level, so on top of it.
                style={{
                  left: side === "left" ? img.x : side === "right" ? img.x + img.w : img.x + img.w / 2,
                  top: side === "top" ? img.y : side === "bottom" ? img.y + img.h : img.y + 28,
                  zIndex: rank.get(img.id),
                }}
                onPointerDown={(e) => startLink(img.id, side, e)}
              />
            )),
          )}
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

          {link && (
            <svg className="connectors link-preview">
              <path d={`M${link.start.x} ${link.start.y} L${link.end.x} ${link.end.y}`} className="connector relation lit" />
            </svg>
          )}

          {draftRect && <div className="region drafting" style={{ left: draftRect.x, top: draftRect.y, width: draftRect.w, height: draftRect.h }} />}

          {visibleCards.map((c) => (
            <Card
              key={c.id}
              card={c}
              foldedCount={c.collapsed ? cardsBelow(c.id) : 0}
              onToggleCollapse={() => toggleCollapse(c.id)}
              lit={hover === c.id || hover === c.parentId}
              onHover={(on) => setHover(on ? c.id : null)}
              onHeight={(h) => setHeights((all) => (all[c.id] === h ? all : { ...all, [c.id]: h }))}
              onDescend={(text, context, clientY) => descend(c, text, context, toWorld(0, clientY).y)}
              onRetry={() => retry(c)}
              onAnswer={(text) => answer(c, text)}
              onFocus={focusOn}
              onAddPaper={(paper) => addPaperPages(paper, "1-2", { x: c.x + c.w + GAP, y: c.y })}
              onAsk={async (text) => {
                try {
                  await api.chat(c.id, text);
                  await refresh();
                } catch (e) {
                  setError(`Couldn't send: ${e}`);
                }
              }}
              onGrab={(e) => startMove(c.id, e)}
              onPortDown={(side, e) => startLink(c.id, side, e)}
              linking={!!link && link.from !== c.id}
              relatesNames={c.relates?.map((id) => {
                const s = byId.get(id);
                return s?.kind === "card" ? (s.subject ?? "this") : s?.kind === "image" ? (s.topic ?? s.name) : "a removed card";
              })}
              moving={drag?.ids.includes(c.id) ?? false}
              z={rank.get(c.id) ?? 0}
              selected={selected === c.id}
              onRemove={() => remove(c.id, `remove “${(c.subject ?? "card").slice(0, 30)}”`)}
            />
          ))}
        </div>
      </div>
      {arxivOpen && <ArxivPanel onAdd={(paper, pages) => addPaperPages(paper, pages)} onClose={() => setArxivOpen(false)} />}
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
        </div>
      )}
    </div>
  );
}

/** A link to read or a question to explain: a start that isn't an image. */
function StartBox({ onStart, big = false }: { onStart: (input: string) => Promise<void>; big?: boolean }) {
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
      }}
    >
      <input
        value={value}
        disabled={busy}
        autoFocus={big}
        placeholder={big ? "A link to read, or a question to explain…" : "Start from a link or a question… (or drop an image anywhere)"}
        title="Paste a link (e.g. a Wikipedia page) to read it here, or type a question to have it explained"
        onChange={(e) => setValue(e.target.value)}
      />
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
