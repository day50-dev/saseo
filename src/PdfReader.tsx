// A whole PDF on the canvas, read in one place a page at a time, with a pager, the way a video plays
// in one place with its timeline. Where a page is worth working on, "Take this page out" puts it on
// the canvas as its own page (as stopping a video puts its frame there), to box and select on.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
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

const texts = new Map<string, Promise<string[]>>();
/** Every page's words, lower-cased and run together, read once per PDF for finding in it. */
function textsOf(file: string): Promise<string[]> {
  let p = texts.get(file);
  if (!p) {
    p = docOf(file).then(async (doc) => {
      const out: string[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const tc = await (await doc.getPage(n)).getTextContent();
        out.push(squash(tc.items.map((i) => ("str" in i ? i.str : "")).join(" ")));
      }
      return out;
    });
    texts.set(file, p);
    p.catch(() => texts.delete(file));
  }
  return p;
}
/** Lower case, one space between words: so a phrase split across lines is still found. */
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

export function PdfReader({
  item,
  page,
  zoom,
  z,
  selected,
  taken,
  onPage,
  onTake,
  onResize,
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
  /** Drag its right edge or corner to make it bigger or smaller. */
  onResize: (e: React.PointerEvent) => void;
}) {
  const d = item.doc!;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState(String(page));
  const [failed, setFailed] = useState<string | null>(null);
  const lastTurn = useRef(0);
  useEffect(() => setTyped(String(page)), [page]);
  // Finding: the words looked for, the pages that have them, and which of those is showing.
  const [find, setFind] = useState("");
  const [found, setFound] = useState<{ q: string; pages: number[] } | null>(null);
  const [finding, setFinding] = useState(false);
  const look = async (back: boolean) => {
    const q = squash(find).trim();
    if (!q) return setFound(null);
    let pages = found?.q === q ? found.pages : null;
    if (!pages) {
      setFinding(true);
      try {
        pages = (await textsOf(d.file)).flatMap((t, i) => (t.includes(q) ? [i + 1] : []));
      } finally {
        setFinding(false);
      }
      setFound({ q, pages });
      // A new search starts from the page showing (this one, if it has them).
      const here = pages.find((n) => n >= page) ?? pages[0];
      if (here) go(here);
      return;
    }
    if (!pages.length) return;
    // Again: on to the next page that has them, or back to the one before; round at the ends.
    const next = back ? ([...pages].reverse().find((n) => n < page) ?? pages[pages.length - 1]) : (pages.find((n) => n > page) ?? pages[0]);
    go(next);
  };
  const mark = found?.pages.length ? found.q : "";

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
        // What's being found, marked where it is on the page (each run of text that has it).
        if (mark) {
          const tc = await pg.getTextContent();
          ctx.fillStyle = "rgba(255, 196, 0, 0.38)";
          for (const it of tc.items) {
            if (!("str" in it) || !squash(it.str).includes(mark)) continue;
            const t = Util.transform(viewport.transform, it.transform);
            const h = Math.hypot(t[2], t[3]);
            const w = it.width * viewport.scale;
            // Within the run, roughly where the words fall, by their share of its characters.
            const at = squash(it.str).indexOf(mark) / Math.max(1, it.str.length);
            const len = mark.length / Math.max(1, it.str.length);
            ctx.fillRect(t[4] + w * at - 1, t[5] - h, w * len + 2, h * 1.25);
          }
          if (cancelled) return;
        }
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
  }, [d.file, page, item.w, item.h, zoom, mark]);

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
        <form
          className="doc-find"
          onSubmit={(e) => {
            e.preventDefault();
            void look(false);
          }}
        >
          <input
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              if (!e.target.value.trim()) setFound(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) (e.preventDefault(), void look(true));
              if (e.key === "Escape") (setFind(""), setFound(null));
            }}
            placeholder="Find"
            aria-label="Find in this PDF"
            title="Find in this PDF: Enter for the next page with it, Shift+Enter for the one before"
          />
          {finding ? (
            <span className="spinner" />
          ) : found ? (
            <span className="muted small doc-found">
              {found.pages.length ? `${found.pages.includes(page) ? found.pages.indexOf(page) + 1 : "–"}/${found.pages.length} ${found.pages.length === 1 ? "page" : "pages"}` : "Not found"}
            </span>
          ) : null}
        </form>
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
      <div className="video-resize" title="Drag to make this PDF bigger or smaller" onPointerDown={onResize} />
      <div className="video-resize-grip" title="Drag to make this PDF bigger or smaller" onPointerDown={onResize} />
    </div>
  );
}
