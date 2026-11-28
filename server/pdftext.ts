// A whole PDF as text, so the librarian can read it like a linked page: paragraphs with "## "
// headings, each paragraph knowing the page it's on (for "p. 7" in what's said about it).
//
// An arXiv paper is read from arXiv's own HTML version when there is one: it has the real section
// headings, and its formulas come through as LaTeX. Any other PDF, or a paper without the HTML, is
// read with pdftotext. Either way the references are left out: they're a list to look things up
// in, not something to restructure. A reading is kept per file, so it's done once.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { paragraphs } from "../shared/canvas.ts";
import { assetPath, DATA_DIR } from "./canvas.ts";
import { Permanent, readPage } from "./pages.ts";

const run = promisify(execFile);
const DIR = path.join(DATA_DIR, "pdftext");

export interface PdfText {
  /** Paragraphs separated by blank lines; "## " starts a heading. */
  text: string;
  /** For each paragraph (as `paragraphs(text)` numbers them), its page, from 1; 0 when it couldn't be placed. */
  pageOf: number[];
  /** Where the text came from. */
  from: "arxiv-html" | "pdftotext";
}

/** Each page's text, as pdftotext reads it. */
async function pagesOf(file: string): Promise<string[]> {
  const out = (await run("pdftotext", ["-q", "-enc", "UTF-8", file, "-"], { maxBuffer: 1 << 26 })).stdout;
  return out.split("\f").slice(0, -1).length ? out.split("\f").filter((_, i, a) => i < a.length - 1 || a[i].trim()) : [out];
}

// "A Proofs" alone is too like an ordinary title ("A Paper on Folding"); "A.1 Proofs" and "Appendix A" are headings.
const HEADING = /^(?:(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)\.?\s+[A-Z][^.]{1,80}|Abstract|References|Bibliography|Acknowledge?ments?|Appendix(?:\s+[A-Z])?.{0,80})$/;

/** A page's text cut into paragraphs: lines rejoined, words split by a hyphen at a line's end mended, headings marked. */
export function pageParagraphs(page: string): string[] {
  const blocks = page.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let b = blocks[i];
    // A section number on a line of its own, then its title ("1", "Introduction").
    if (/^\d+(\.\d+)*$/.test(b) && blocks[i + 1] && blocks[i + 1].length < 80 && !blocks[i + 1].includes("\n")) b = `${b} ${blocks[++i]}`;
    const joined = b.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2").replace(/\s*\n\s*/g, " ").trim();
    // Page numbers, running heads and arXiv's stamp in the margin carry nothing.
    if (/^\d{1,3}$/.test(joined) || /^arXiv:\d{4}\.\d{4,5}/.test(joined)) continue;
    out.push(joined.length < 90 && HEADING.test(joined) ? `## ${joined}` : joined);
  }
  return out;
}

/** Leaves out the references: from their heading to the next heading that isn't part of them (an appendix), or the end. */
export function withoutReferences(paras: { text: string; page: number }[]): { text: string; page: number }[] {
  const out: { text: string; page: number }[] = [];
  let skipping = false;
  for (const p of paras) {
    if (/^## (?:\d+\.?\s+)?(References|Bibliography)\b/i.test(p.text)) {
      skipping = true;
      continue;
    }
    if (skipping && /^## /.test(p.text) && /appendix|^## [A-Z](\.\d+)*\s/i.test(p.text)) skipping = false;
    if (!skipping) out.push(p);
  }
  return out;
}

/** Only the words of three or more letters, lower-cased: citations, numbers and formulas differ between versions of a paper, words don't. */
const plainWords = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3);

/** The page a paragraph (read from elsewhere, such as arXiv's HTML) is on: where a run of its plain words is found. */
export function placeOnPages(paras: string[], pages: string[]): number[] {
  const flat = pages.map((p) => ` ${plainWords(p).join(" ")} `);
  let last = 1;
  const found = paras.map((p) => {
    const words = plainWords(p.replace(/\\\(.*?\\\)|\\\[[\s\S]*?\\\]/g, " "));
    for (const start of [0, Math.floor(words.length / 3), Math.floor((2 * words.length) / 3)]) {
      const run = words.slice(start, start + 5);
      if (run.length < 3) continue;
      const probe = ` ${run.join(" ")} `;
      // From the page the last paragraph was on, onwards first: papers are read in order.
      const order = [...flat.keys()].sort((a, b) => (a + 1 >= last ? 0 : 1) - (b + 1 >= last ? 0 : 1) || a - b);
      const hit = order.find((i) => flat[i].includes(probe));
      if (hit !== undefined) return (last = hit + 1);
    }
    return 0;
  });
  // A paragraph that couldn't be found (a heading, a formula) is on the page of the next one that was, else the one before.
  return found.map((n, i) => n || found.slice(i + 1).find(Boolean) || [...found.slice(0, i)].reverse().find(Boolean) || 0);
}

/** The arXiv id in a link to an arXiv PDF, if it is one. */
const arxivIdOf = (url: string) => /arxiv\.org\/(?:pdf|abs)\/([^?#\s]+?)(?:\.pdf)?(?:[?#]|$)/.exec(url)?.[1] ?? "";

/** Reads a PDF on the canvas (its kept file) whole; once per file. */
export async function readPdf(doc: { file: string; url: string; title: string }): Promise<PdfText> {
  const kept = path.join(DIR, `${doc.file}.json`);
  try {
    return JSON.parse(await readFile(kept, "utf8")) as PdfText;
  } catch {}
  const found = assetPath(doc.file);
  if (!found) throw new Permanent("That PDF's file is missing.");
  const pages = await pagesOf(found.file);
  let read: PdfText | null = null;
  const id = arxivIdOf(doc.url);
  if (id) {
    try {
      const html = await readPage(`https://arxiv.org/html/${id}`);
      // The HTML's own title line is replaced by the PDF's title, read before.
      const paras = paragraphs(html.text).filter((p, i) => !(i === 0 && p.startsWith("## ")));
      const placed = placeOnPages(paras, pages);
      const kept_ = withoutReferences(paras.map((text, i) => ({ text, page: placed[i] })));
      if (kept_.length > 10) read = { text: kept_.map((p) => p.text).join("\n\n"), pageOf: kept_.map((p) => p.page), from: "arxiv-html" };
    } catch {
      // No HTML version (older papers, or ones that wouldn't convert): pdftotext it is.
    }
  }
  if (!read) {
    const paras = withoutReferences(pages.flatMap((page, i) => pageParagraphs(page).map((text) => ({ text, page: i + 1 }))));
    if (!paras.length) throw new Permanent("Couldn't find any text in that PDF (it may be scanned pages).");
    read = { text: paras.map((p) => p.text).join("\n\n"), pageOf: paras.map((p) => p.page), from: "pdftotext" };
  }
  await mkdir(DIR, { recursive: true });
  await writeFile(kept, JSON.stringify(read));
  return read;
}
