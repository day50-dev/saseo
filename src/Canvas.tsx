import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CARD_WIDTH, type CardItem, type ImageItem, type Item, MIN_CHILD_GAP, type Rect, type RegionItem } from "../shared/canvas.ts";
import { Card } from "./Card.tsx";
import { assetUrl, canvasApi } from "./canvasApi.ts";

interface View {
  x: number;
  y: number;
  scale: number;
}

const GAP = 64; // horizontal gap between a source and its explanations
const STACK_GAP = 24; // vertical gap between cards in one column
const PENDING_HEIGHT = 900; // space reserved for a card that hasn't been written yet; diagram cards run 700-1100px
const MAX_IMAGE_WIDTH = 900;

function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem("librarian.view") ?? "");
    if (typeof v?.x === "number" && typeof v?.scale === "number") return v;
  } catch {}
  return { x: 40, y: 80, scale: 1 };
}

function saveView(v: View) {
  try {
    localStorage.setItem("librarian.view", JSON.stringify(v));
  } catch {}
}

const isPending = (c: CardItem) => c.stage !== "done" && c.stage !== "failed";

type Mode = "select" | "pan";

function loadMode(): Mode {
  try {
    return localStorage.getItem("librarian.mode") === "pan" ? "pan" : "select";
  } catch {
    return "select";
  }
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function Canvas() {
  const [items, setItems] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(loadView);
  const [draft, setDraft] = useState<{ imageId: string; start: { x: number; y: number }; end: { x: number; y: number } } | null>(null);
  // A container being dragged, with everything that hangs off it.
  const [drag, setDrag] = useState<{
    ids: string[];
    start: { x: number; y: number };
    orig: Record<string, { x: number; y: number }>;
    minDx: number;
    dx: number;
    dy: number;
  } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
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
      const s = await canvasApi.state();
      // Hidden items stay in the log (undo can bring them back) but aren't drawn or laid out around.
      setItems(s.items.filter((i) => !i.hidden));
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll only while some card is still being written.
  const pending = items.some((i) => i.kind === "card" && isPending(i));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [pending, refresh]);

  useEffect(() => saveView(view), [view]);

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
        hiddenIds = (await canvasApi.hide(ids)).ids;
      },
      redo: () => canvasApi.show(hiddenIds),
    });
  };

  const remove = async (id: string, label: string) => {
    try {
      const { ids } = await canvasApi.hide([id]);
      pushStep({ label, undo: () => canvasApi.show(ids), redo: () => canvasApi.hide(ids) });
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
      const img = await canvasApi.addImage(file, { x: Math.round(at.x), y: Math.round(at.y), w, h, naturalW: el.naturalWidth, naturalH: el.naturalHeight });
      added("add image", [img.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't add image: ${e}`);
    } finally {
      URL.revokeObjectURL(url);
    }
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

  /** Right edge of what a card explains: the box on the image, or the card above it. */
  const parentRight = (card: CardItem): number | null => {
    const parent = byId.get(card.parentId);
    if (parent?.kind === "card") return parent.x + parent.w;
    if (parent?.kind === "region") {
      const r = regionWorld(parent);
      return r ? r.x + r.w : null;
    }
    return null;
  };

  const startMove = (rootId: string, e: React.PointerEvent) => {
    if (panning || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const ids = subtree(rootId);
    const orig: Record<string, { x: number; y: number }> = {};
    for (const id of ids) {
      const i = byId.get(id);
      if (i && i.kind !== "region") orig[id] = { x: i.x, y: i.y };
    }
    // A card can go anywhere except left of what it explains.
    const root = byId.get(rootId);
    let minDx = -Infinity;
    if (root?.kind === "card") {
      const edge = parentRight(root);
      if (edge !== null) minDx = edge + MIN_CHILD_GAP - root.x;
    }
    setDrag({ ids, start: toWorld(e.clientX, e.clientY), orig, minDx, dx: 0, dy: 0 });
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
    const to = changed.map((c) => ({ id: c.id, x: c.x, y: Math.round(pos.get(c.id)!.y) }));
    const from = changed.map((c) => ({ id: c.id, x: c.x, y: c.y }));
    try {
      await canvasApi.move(to);
      pushStep({ label: "untangle", undo: () => canvasApi.move(from), redo: () => canvasApi.move(to) });
    } catch (e) {
      setError(`Couldn't untangle: ${e}`);
    }
    await refresh();
  };

  const finishMove = async (d: NonNullable<typeof drag>) => {
    setDrag(null);
    if (Math.abs(d.dx) + Math.abs(d.dy) < 3) return;
    const to = Object.entries(d.orig).map(([id, p]) => ({ id, x: Math.round(p.x + d.dx), y: Math.round(p.y + d.dy) }));
    const from = Object.entries(d.orig).map(([id, p]) => ({ id, x: p.x, y: p.y }));
    // Show the new place at once; the refresh confirms it.
    setItems((all) => all.map((i) => (d.orig[i.id] && i.kind !== "region" ? { ...i, x: i.x + d.dx, y: i.y + d.dy } : i)));
    try {
      await canvasApi.move(to);
      pushStep({ label: "move", undo: () => canvasApi.move(from), redo: () => canvasApi.move(to) });
    } catch (e) {
      setError(`Couldn't move: ${e}`);
    }
    await refresh();
  };

  const onStagePointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
    } else if (drag) {
      const p = toWorld(e.clientX, e.clientY);
      setDrag({ ...drag, dx: Math.max(drag.minDx, p.x - drag.start.x), dy: p.y - drag.start.y });
    } else if (draft) {
      setDraft({ ...draft, end: toWorld(e.clientX, e.clientY) });
    }
  };

  const onStagePointerUp = async () => {
    pan.current = null;
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
      const res = await canvasApi.addRegion({ imageId: img.id, rect, card: { x: cardX, y: slotY(cardX, Math.round(y0)) }, marked, crop });
      added("box", [res.region.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't send the selection: ${e}`);
    }
  };

  // ---- Descending from a card ----

  const descend = async (parent: CardItem, selection: string, worldY: number) => {
    const x = parent.x + CARD_WIDTH + GAP;
    try {
      const res = await canvasApi.descend({ parentId: parent.id, selection, x, y: slotY(x, Math.round(worldY - 20)) });
      added(`explain “${selection.slice(0, 30)}”`, [res.card.id]);
      await refresh();
    } catch (e) {
      setError(`Couldn't go further down: ${e}`);
    }
  };

  const retry = async (card: CardItem) => {
    try {
      const parent = byId.get(card.parentId);
      if (parent?.kind === "region") {
        const el = imgRefs.current[parent.imageId];
        if (!el) throw new Error("its image isn't on the canvas");
        await canvasApi.retry(card.id, renderRegion(el, parent.rect));
      } else {
        await canvasApi.retry(card.id);
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
      await canvasApi.collapse([id], next);
      pushStep({
        label: next ? "collapse" : "expand",
        undo: () => canvasApi.collapse([id], !next),
        redo: () => canvasApi.collapse([id], next),
      });
    } catch (e) {
      setError(`Couldn't ${next ? "collapse" : "expand"}: ${e}`);
    }
    await refresh();
  };

  // ---- Connectors ----

  const connectors = visibleCards.flatMap((c) => {
    const parent = byId.get(c.parentId);
    let from: { x: number; y: number } | null = null;
    if (parent?.kind === "region") {
      const r = regionWorld(parent);
      if (r) from = { x: r.x + r.w, y: r.y + r.h / 2 };
    } else if (parent?.kind === "card") {
      from = { x: parent.x + parent.w, y: parent.y + 28 };
    }
    if (!from) return [];
    const to = { x: c.x, y: c.y + 28 };
    const mx = (from.x + to.x) / 2;
    const lit = hover === c.id || hover === c.parentId;
    return [
      <path
        key={c.id}
        d={`M${from.x} ${from.y} C${mx} ${from.y} ${mx} ${to.y} ${to.x} ${to.y}`}
        className={lit ? "connector lit" : "connector"}
      />,
    ];
  });

  const draftRect = draft && {
    x: Math.min(draft.start.x, draft.end.x),
    y: Math.min(draft.start.y, draft.end.y),
    w: Math.abs(draft.end.x - draft.start.x),
    h: Math.abs(draft.end.y - draft.start.y),
  };

  return (
    <div className="canvas-page">
      <div className="toolbar">
        <strong>Librarian</strong>
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
        <a href="#settings">Settings</a>
      </div>
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
        {loaded && images.length === 0 && (
          <div className="empty" data-pan="1">
            <h2 data-pan="1">Drop an image of something that stopped you</h2>
            <p className="muted" data-pan="1">A slide, a page, a screenshot. Then drag a box over the part you want explained.</p>
          </div>
        )}
        <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
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
              className="source-image"
              // A collapsed image stays loaded (retry reads its pixels) but out of view.
              style={{ left: img.x, top: img.y, width: img.w, height: img.h, display: img.collapsed ? "none" : undefined }}
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
              style={{ left: img.x, top: img.y - 26, width: img.w }}
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
              <span aria-hidden>⠿</span> {img.name}
              {img.collapsed && <span className="folded-count">{cardsBelow(img.id)} cards folded</span>}
            </div>
          ))}
          {images.filter((img) => !img.collapsed).map((img) => (
            <button
              key={`x-${img.id}`}
              type="button"
              className="remove-btn on-image"
              style={{ left: img.x + img.w - 30, top: img.y + 6 }}
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
                style={{ left: w.x, top: w.y, width: w.w, height: w.h }}
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
              onDescend={(text, clientY) => descend(c, text, toWorld(0, clientY).y)}
              onRetry={() => retry(c)}
              onGrab={(e) => startMove(c.id, e)}
              moving={drag?.ids.includes(c.id) ?? false}
              onRemove={() => remove(c.id, `remove “${(c.subject ?? "card").slice(0, 30)}”`)}
            />
          ))}
        </div>
      </div>
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
