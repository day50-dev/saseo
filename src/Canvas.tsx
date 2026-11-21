import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CARD_WIDTH, type CardItem, type ImageItem, type Item, type Rect, type RegionItem } from "../shared/canvas.ts";
import { Card } from "./Card.tsx";
import { assetUrl, canvasApi } from "./canvasApi.ts";

interface View {
  x: number;
  y: number;
  scale: number;
}

const GAP = 64; // horizontal gap between a source and its explanations
const STACK_GAP = 24; // vertical gap between cards in one column
const PENDING_HEIGHT = 380; // space reserved for a card that hasn't filled in yet
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

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const images = items.filter((i): i is ImageItem => i.kind === "image");
  const regions = items.filter((i): i is RegionItem => i.kind === "region");
  const cards = items.filter((i): i is CardItem => i.kind === "card");

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

  /** First free y in the column at x, at or below `wanted`. Placement is decided once and never revisited. */
  const slotY = (x: number, wanted: number) => {
    let y = wanted;
    const column = cards.filter((c) => Math.abs(c.x - x) < 1).sort((a, b) => a.y - b.y);
    for (const c of column) {
      const bottom = c.y + (heights[c.id] ?? PENDING_HEIGHT);
      if (y < bottom + STACK_GAP && y + 120 > c.y - STACK_GAP) y = bottom + STACK_GAP;
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

  const onStagePointerMove = (e: React.PointerEvent) => {
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
    } else if (draft) {
      setDraft({ ...draft, end: toWorld(e.clientX, e.clientY) });
    }
  };

  const onStagePointerUp = async () => {
    pan.current = null;
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

  // ---- Connectors ----

  const connectors = cards.flatMap((c) => {
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
              style={{ left: img.x, top: img.y, width: img.w, height: img.h }}
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

          {regions.map((r) => {
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

          {cards.map((c) => (
            <Card
              key={c.id}
              card={c}
              lit={hover === c.id || hover === c.parentId}
              onHover={(on) => setHover(on ? c.id : null)}
              onHeight={(h) => setHeights((all) => (all[c.id] === h ? all : { ...all, [c.id]: h }))}
              onDescend={(text, clientY) => descend(c, text, toWorld(0, clientY).y)}
              onRetry={() => retry(c)}
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
