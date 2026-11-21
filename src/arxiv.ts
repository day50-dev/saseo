// Adding arXiv papers to a canvas: search through the server, and render chosen PDF pages to
// images in the browser, each keeping a link back to the paper.
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ImageSource, Paper } from "../shared/canvas.ts";

GlobalWorkerOptions.workerSrc = workerUrl;

export async function searchArxiv(q: string, sort: "relevance" | "date" = "relevance"): Promise<{ total: number; papers: Paper[] }> {
  const res = await fetch(`/api/arxiv/search?${new URLSearchParams({ q, sort })}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** "1-3, 5" → [1, 2, 3, 5], kept within the paper and capped so one click can't add a hundred pages. */
export function parsePages(spec: string, count: number, max = 12): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let p = Math.min(a, b); p <= Math.max(a, b) && out.size < max; p++) if (p >= 1 && p <= count) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

export interface RenderedPage {
  file: File;
  width: number;
  height: number;
  source: ImageSource;
}

/** Fetches the paper's PDF (via the server, which caches it) and renders the chosen pages. */
export async function renderPages(paper: Paper, pagesSpec: string): Promise<{ pages: RenderedPage[]; count: number }> {
  const task = getDocument({ url: `/api/arxiv/pdf?${new URLSearchParams({ id: paper.id })}` });
  const doc = await task.promise;
  const wanted = parsePages(pagesSpec, doc.numPages);
  const pages: RenderedPage[] = [];
  for (const n of wanted) {
    const page = await doc.getPage(n);
    // Twice the PDF's own size: sharp enough to read and box small math.
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("render failed"))), "image/png"));
    const name = `arXiv ${paper.id} p${n}.png`;
    pages.push({
      file: new File([blob], name, { type: "image/png" }),
      width: canvas.width,
      height: canvas.height,
      source: { kind: "arxiv", id: paper.id, title: paper.title, page: n, url: paper.url },
    });
  }
  const count = doc.numPages;
  await task.destroy();
  return { pages, count };
}
