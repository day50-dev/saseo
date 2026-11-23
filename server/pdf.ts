// A PDF linked on the canvas becomes its pages: each one its own single-page PDF (sliced with
// poppler's pdfseparate), drawn crisp at any zoom, with a rendering beside it (pdftoppm) for
// boxing and for the vision model, and its exact text (pdftotext). Long documents stop at a cap.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { arxivPdf, parseArxivId } from "./arxiv.ts";
import { saveAsset } from "./canvas.ts";

const run = promisify(execFile);

/** Runs a tool whose chatter doesn't matter (some PDFs make poppler warn thousands of times). */
const quiet = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code})`))));
  });

/** How many pages of one PDF go on the canvas. */
export const PDF_PAGE_CAP = 80;
const MAX_PDF_BYTES = 200 * 1024 * 1024;

/** An arXiv paper (abs or pdf link), or a link to a .pdf file. */
export function pdfLink(input: string): { arxiv?: string; url: string } | null {
  if (!/^https?:\/\//i.test(input.trim())) return null;
  const url = input.trim();
  if (/arxiv\.org\/(abs|pdf)\//i.test(url)) {
    const id = parseArxivId(url);
    if (id) return { arxiv: id, url: `https://arxiv.org/abs/${id}` };
  }
  if (/\.pdf($|[?#])/i.test(url)) return { url };
  return null;
}

/** Whether a link serves a PDF, for links that don't say so in their name. */
export async function servesPdf(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(8000) });
    return /application\/pdf/i.test(r.headers.get("content-type") ?? "");
  } catch {
    return false;
  }
}

async function download(url: string): Promise<Buffer> {
  const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Librarian)" }, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`The PDF answered HTTP ${r.status}.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = r.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PDF_BYTES) {
      await reader.cancel();
      throw new Error("That PDF is over 200 MB.");
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  if (buf.subarray(0, 5).toString() !== "%PDF-") throw new Error("That link didn't give a PDF.");
  return buf;
}

const pngSize = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

export interface PdfPage {
  /** The page as a single-page PDF (asset name). */
  pdf: string;
  /** Its rendering (asset name). */
  png: string;
  w: number;
  h: number;
  text: string;
  n: number;
}

/** Slices a linked PDF into its first pages. */
export async function slicePdf(link: { arxiv?: string; url: string }): Promise<{ title: string; total: number; pages: PdfPage[] }> {
  const bytes = link.arxiv ? await arxivPdf(link.arxiv) : await download(link.url);
  const dir = await mkdtemp(path.join(tmpdir(), "librarian-pdf-"));
  try {
    const file = path.join(dir, "in.pdf");
    await writeFile(file, bytes);
    const info = (await run("pdfinfo", [file], { maxBuffer: 1 << 26 })).stdout;
    const total = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
    if (!total) throw new Error("Couldn't read that PDF.");
    const n = Math.min(total, PDF_PAGE_CAP);
    const named = /^Title:\s+(.+)$/m.exec(info)?.[1]?.trim();
    const title = link.arxiv ? `arXiv ${link.arxiv}${named ? `: ${named}` : ""}` : named || decodeURIComponent(link.url.split(/[?#]/)[0].split("/").pop() ?? "PDF");
    await quiet("pdfseparate", ["-f", "1", "-l", String(n), file, path.join(dir, "page-%d.pdf")]);
    // About 110 dpi: sharp enough to box a formula, small enough for 80 of them.
    await quiet("pdftoppm", ["-q", "-r", "110", "-png", "-f", "1", "-l", String(n), file, path.join(dir, "r")]);
    const renders = (await readdir(dir)).filter((f) => /^r-\d+\.png$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
    const pages: PdfPage[] = [];
    // A few at a time: each is a read, two saves and a pdftotext.
    for (let start = 1; start <= n; start += 8) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(8, n - start + 1) }, async (_, k) => {
          const i = start + k;
          const png = await readFile(path.join(dir, renders[i - 1]));
          const text = (await run("pdftotext", ["-q", "-layout", "-f", String(i), "-l", String(i), file, "-"], { maxBuffer: 1 << 24 }).catch(() => ({ stdout: "" }))).stdout;
          return {
            n: i,
            pdf: await saveAsset(await readFile(path.join(dir, `page-${i}.pdf`)), "application/pdf"),
            png: await saveAsset(png, "image/png"),
            ...pngSize(png),
            text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 20_000),
          };
        }),
      );
      pages.push(...batch);
    }
    return { title, total, pages };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
