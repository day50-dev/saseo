// A whole PDF on the canvas, read in one place a page at a time, with a pager, the way a video plays
// in one place with its timeline. Where a page is worth working on, "Take this page out" puts it on
// the canvas as its own page (as stopping a video puts its frame there), to box and select on.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import type { ImageItem } from "../shared/canvas.ts";
import { assetUrl } from "./canvasApi.ts";

GlobalWorkerOptions.workerSrc = workerUrl;

export const PAGER_BAR = 52; // world pixels under the page taken by its pager

const docs = new Map<string, Promise<PDFDocumentProxy>>();
/** A kept PDF, loaded once however many times it's drawn. */
function docOf(file: string): Promise<PDFDocumentProxy> {
  let p = docs.get(file);
  if (!p) {
    p = getDocument({ url: assetUrl(file) }).promise;
    docs.set(file, p);
    p.catch(() => docs.delete(file));
  }
  return p;
}

export function PdfReader({
  item,
  page,
  zoom,
  z,
  selected,
  taken,
  onPage,
  onTake,
}: {
  item: ImageItem;
  /** The page showing, 1-based. */
  page: number;
  /** The canvas's zoom, so the page is drawn sharp for it. */
  zoom: number;
  z: number | undefined;
  selected: boolean;
  /** Pages already taken out, so the pager can say so. */
  taken: Set<number>;
  onPage: (n: number) => void;
  /** Take this page out onto the canvas. */
  onTake: (n: number) => Promise<void>;
}) {
  const d = item.doc!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState(String(page));
  const [failed, setFailed] = useState<string | null>(null);
  const lastTurn = useRef(0);
  useEffect(() => setTyped(String(page)), [page]);

  // The page, sharp for the zoom, fitted inside the frame (pages needn't share a shape).
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const t = window.setTimeout(async () => {
      try {
        const doc = await docOf(d.file);
        const pg = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
        const c = canvas.current;
        if (cancelled || !c) return;
        const base = pg.getViewport({ scale: 1 });
        const fit = Math.min(item.w / base.width, item.h / base.height);
        const scale = Math.min(4, fit * zoom * (window.devicePixelRatio || 1));
        const viewport = pg.getViewport({ scale });
        const off = document.createElement("canvas");
        off.width = Math.round(viewport.width);
        off.height = Math.round(viewport.height);
        const ctx = off.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, off.width, off.height);
        const r = pg.render({ canvas: off, canvasContext: ctx, viewport });
        task = r;
        await r.promise;
        if (cancelled) return;
        c.width = off.width;
        c.height = off.height;
        c.style.width = `${base.width * fit}px`;
        c.style.height = `${base.height * fit}px`;
        c.getContext("2d")!.drawImage(off, 0, 0);
        setDrawn(true);
        setFailed(null);
      } catch (e) {
        if (!cancelled && !(e instanceof Error && e.name === "RenderingCancelledException")) setFailed(String(e));
      }
    }, drawn ? 120 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.file, page, item.w, item.h, zoom]);

  const go = (n: number) => onPage(Math.min(Math.max(1, n), d.pages));
  const take = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onTake(page);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`doc-item ${selected ? "selected" : ""}`}
      data-image-id={item.id}
      style={{ left: item.x, top: item.y, width: item.w, zIndex: z, display: item.collapsed ? "none" : undefined }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        if (e.key === "ArrowRight" || e.key === "PageDown") (e.preventDefault(), go(page + 1));
        if (e.key === "ArrowLeft" || e.key === "PageUp") (e.preventDefault(), go(page - 1));
      }}
      tabIndex={0}
    >
      <div
        className="doc-frame"
        style={{ height: item.h }}
        // The wheel turns pages: one notch, one page.
        onWheel={(e) => {
          if (e.ctrlKey || Math.abs(e.deltaY) < 4) return;
          e.stopPropagation();
          // A trackpad sends a stream of small scrolls: one page for each burst, not one per event.
          const now = Date.now();
          if (now - lastTurn.current < 350) return;
          lastTurn.current = now;
          go(page + (e.deltaY > 0 ? 1 : -1));
        }}
      >
        {/* The first page as the server drew it, until pdf.js has drawn the one asked for. */}
        {!drawn && <img className="doc-cover" src={assetUrl(item.asset)} alt="" draggable={false} />}
        <canvas ref={canvas} className="doc-canvas" style={{ opacity: drawn ? 1 : 0 }} />
        {failed && <p className="fail small doc-failed">Couldn't draw this page: {failed}</p>}
      </div>
      <div className="doc-bar" style={{ height: PAGER_BAR }}>
        <button type="button" className="secondary doc-turn" disabled={page <= 1} onClick={() => go(page - 1)} title="Previous page (←)">
          ‹
        </button>
        <form
          className="doc-pageno"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(typed);
            if (Number.isFinite(n)) go(Math.round(n));
          }}
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ""))} inputMode="numeric" aria-label="Page" onBlur={() => setTyped(String(page))} />
          <span className="muted small">of {d.pages}</span>
        </form>
        <button type="button" className="secondary doc-turn" disabled={page >= d.pages} onClick={() => go(page + 1)} title="Next page (→)">
          ›
        </button>
        <button type="button" className="doc-take" disabled={busy} onClick={take} title="Put this page on the canvas, to box anything on it or select its words">
          {busy ? (
            <>
              <span className="spinner" /> Taking it out…
            </>
          ) : taken.has(page) ? (
            "Take this page out again"
          ) : (
            "Take this page out"
          )}
        </button>
      </div>
    </div>
  );
}
