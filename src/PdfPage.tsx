// A page of a PDF on the canvas, drawn from the page itself (a single-page PDF): crisp at any zoom,
// with its real text over it, so a block of words can be selected and explained like words on a
// card. Dragging anywhere that isn't text (a figure, an equation, a margin) still draws a box,
// on the image underneath.
import { getDocument, GlobalWorkerOptions, type PDFPageProxy, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import type { ImageItem } from "../shared/canvas.ts";
import { assetUrl } from "./canvasApi.ts";

GlobalWorkerOptions.workerSrc = workerUrl;

const loaded = new Map<string, Promise<PDFPageProxy>>();
/** The page of a single-page PDF, loaded once. */
function pageOf(asset: string): Promise<PDFPageProxy> {
  let p = loaded.get(asset);
  if (!p) {
    p = getDocument({ url: assetUrl(asset) }).promise.then((doc) => doc.getPage(1));
    loaded.set(asset, p);
    p.catch(() => loaded.delete(asset));
  }
  return p;
}

export function PdfPage({
  img,
  zoom,
  z,
  onSelectText,
}: {
  img: ImageItem;
  /** The canvas's zoom, so the page is redrawn sharp for it. */
  zoom: number;
  z?: number;
  /** Words selected on the page: their exact text, and the box around them on screen. */
  onSelectText: (text: string, screen: DOMRect | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const asset = img.pdf!.asset;

  // Only pages on screen are drawn (a PDF can put eighty on the canvas).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // A selection that starts on this page's words, wherever the mouse is let go.
  const select = useRef(onSelectText);
  select.current = onSelectText;
  useEffect(() => {
    const up = () =>
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || !text.current?.contains(sel.anchorNode)) return;
        const words = !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
        select.current(words, words ? sel.getRangeAt(0).getBoundingClientRect() : null);
      });
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  // The words, once: laid out in the page's own coordinates, scaled with the canvas.
  useEffect(() => {
    if (!visible || !text.current || text.current.childElementCount) return;
    let cancelled = false;
    void (async () => {
      const page = await pageOf(asset);
      if (cancelled || !text.current) return;
      const viewport = page.getViewport({ scale: img.w / page.getViewport({ scale: 1 }).width });
      text.current.style.setProperty("--total-scale-factor", String(viewport.scale));
      await new TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport }).render();
    })().catch((e) => console.warn("text layer", e));
    return () => {
      cancelled = true;
    };
  }, [visible, asset, img.w]);

  // The picture, sharp for the current zoom (redrawn a moment after zooming stops).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const t = window.setTimeout(async () => {
      try {
        const page = await pageOf(asset);
        const c = canvas.current;
        if (cancelled || !c) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(4, (img.w * zoom * (window.devicePixelRatio || 1)) / base.width);
        const viewport = page.getViewport({ scale });
        const off = document.createElement("canvas");
        off.width = Math.round(viewport.width);
        off.height = Math.round(viewport.height);
        const ctx = off.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, off.width, off.height);
        const r = page.render({ canvas: off, canvasContext: ctx, viewport });
        task = r;
        await r.promise;
        if (cancelled) return;
        // Swap in the finished drawing at once, so it never flickers blank.
        c.width = off.width;
        c.height = off.height;
        c.getContext("2d")!.drawImage(off, 0, 0);
        setDrawn(true);
      } catch {
        // Keep the rendering underneath.
      }
    }, drawn ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      task?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, asset, img.w, zoom]);

  return (
    <div
      ref={box}
      className="pdf-page"
      data-image-id={img.id}
      style={{ left: img.x, top: img.y, width: img.w, height: img.h, zIndex: z, display: img.collapsed ? "none" : undefined }}
    >
      <canvas ref={canvas} className="pdf-page-canvas" style={{ opacity: drawn ? 1 : 0 }} />
      <div
        ref={text}
        className="textLayer"
        // Selecting words, not drawing a box or panning.
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("span")) e.stopPropagation();
        }}
      />
    </div>
  );
}
