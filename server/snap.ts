// Snaps a rough box on a page image to the content actually there. Vision models place boxes on
// the right line reliably but drift along it (measured: up to ±7% of the width), so their boxes
// clip equations or land beside words. The ink on the page knows where things really are.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Rect } from "../shared/canvas.ts";

const run = promisify(execFile);

interface Gray {
  w: number;
  h: number;
  /** Per pixel: is it ink (differs from the page's background)? */
  ink: Uint8Array;
}

const cache = new Map<string, Promise<Gray>>();

/** The image as an ink mask, decoded once per file (ffmpeg does the decoding). */
function inkOf(file: string, w: number, h: number): Promise<Gray> {
  let p = cache.get(file);
  if (!p) {
    p = (async () => {
      const { stdout } = await run("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      const px = new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length);
      // The background is the commonest brightness: light on most slides, dark on some (3Blue1Brown).
      const hist = new Array(256).fill(0);
      for (let i = 0; i < px.length; i += 7) hist[px[i]]++;
      const bg = hist.indexOf(Math.max(...hist));
      const ink = new Uint8Array(px.length);
      for (let i = 0; i < px.length; i++) ink[i] = Math.abs(px[i] - bg) > 70 ? 1 : 0;
      // Frames, rules and borders run most of the way across or down the page; they're not
      // content, and they'd join every row (or column) into one. Leave them out.
      for (let y = 0; y < h; y++) {
        let n = 0;
        for (let x = 0; x < w; x++) n += ink[y * w + x];
        if (n > w * 0.6) for (let x = 0; x < w; x++) ink[y * w + x] = 0;
      }
      for (let x = 0; x < w; x++) {
        let n = 0;
        for (let y = 0; y < h; y++) n += ink[y * w + x];
        if (n > h * 0.6) for (let y = 0; y < h; y++) ink[y * w + x] = 0;
      }
      return { w, h, ink };
    })();
    cache.set(file, p);
    if (cache.size > 50) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** Runs of indices where `has(i)` holds, merging runs separated by gaps of at most `gap`. */
function runs(n: number, has: (i: number) => boolean, gap: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!has(i)) continue;
    if (start < 0) start = i;
    else if (i - last > gap + 1) {
      out.push([start, last]);
      start = i;
    }
    last = i;
  }
  if (start >= 0) out.push([start, last]);
  return out;
}

/**
 * The content a rough box points at: the text rows it overlaps, and within them the clusters of
 * ink it overlaps, with a little margin. Falls back to the box as given when there's no ink there.
 */
export async function snap(file: string, w: number, h: number, box: Rect): Promise<Rect> {
  const { ink } = await inkOf(file, w, h);
  const at = (x: number, y: number) => ink[y * w + x] === 1;
  const clampX = (x: number) => Math.max(0, Math.min(w - 1, Math.round(x)));
  const clampY = (y: number) => Math.max(0, Math.min(h - 1, Math.round(y)));

  // Rows: look across the box widened by half its width each side, since it drifts sideways.
  const wx0 = clampX(box.x - box.w * 0.5);
  const wx1 = clampX(box.x + box.w * 1.5);
  const rowHas = (y: number) => {
    let n = 0;
    for (let x = wx0; x <= wx1; x++) if (at(x, y)) n++;
    return n >= 2;
  };
  // A small gap keeps a fraction's or a subscript's rows with their line.
  const lineGap = Math.max(2, Math.round(h * 0.006));
  const rows = runs(h, rowHas, lineGap).filter(([a, b]) => b >= box.y && a <= box.y + box.h);
  if (!rows.length) return box;
  const y0 = rows[0][0];
  const y1 = rows[rows.length - 1][1];

  // Columns, across the whole width of those rows: clusters of ink split by real gaps (wider than
  // the space between words), so an equation and its label far to the right stay separate.
  const colHas = (x: number) => {
    for (let y = y0; y <= y1; y++) if (at(x, y)) return true;
    return false;
  };
  const wordGap = Math.max(8, Math.round(w * 0.025));
  const clusters = runs(w, colHas, wordGap);
  let picked = clusters.filter(([a, b]) => b >= box.x && a <= box.x + box.w);
  if (!picked.length) {
    // Nothing under the box: the nearest cluster on its line.
    const mid = box.x + box.w / 2;
    picked = [clusters.reduce((best, c) => (Math.abs((c[0] + c[1]) / 2 - mid) < Math.abs((best[0] + best[1]) / 2 - mid) ? c : best))];
  }
  const x0 = picked[0][0];
  const x1 = picked[picked.length - 1][1];
  const m = Math.round(Math.min(w, h) * 0.012);
  const rx = clampX(x0 - m);
  const ry = clampY(y0 - m);
  return { x: rx, y: ry, w: Math.min(w - rx, x1 - x0 + 2 * m), h: Math.min(h - ry, y1 - y0 + 2 * m) };
}
