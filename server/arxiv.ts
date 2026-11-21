// arXiv: search, paper details, and PDFs. arXiv asks API callers to leave at least 3 seconds
// between requests, so every request to it goes through one polite queue, and PDFs are cached.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { Paper } from "../shared/canvas.ts";

const API = "https://export.arxiv.org/api/query";
const USER_AGENT = "librarian (open-source study tool; https://github.com/kristopolous/librarian)";
const GAP_MS = 3100;
const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");
const PDF_DIR = path.join(DATA_DIR, "arxiv");

let queue: Promise<unknown> = Promise.resolve();
let last = 0;

/** Every arXiv request waits its turn, at least 3 seconds after the one before. */
function politely<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      last = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** New-style (2609.13096, optional version) and old-style (hep-th/9901001) arXiv ids. */
const ID = /(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/;

/** Finds an arXiv id in an id, abs/pdf URL, or "arXiv:" reference; null if there isn't one. */
export function parseArxivId(input: string): string | null {
  return input.trim().match(ID)?.[1] ?? null;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function toPaper(e: Record<string, unknown>): Paper {
  const id = parseArxivId(String(e.id)) ?? String(e.id);
  const authors = list(e.author as { name: string } | { name: string }[]).map((a) => clean(a.name));
  const category = (e["arxiv:primary_category"] as { term?: string } | undefined)?.term ?? "";
  return {
    id,
    title: clean(e.title),
    authors,
    summary: clean(e.summary),
    published: String(e.published ?? "").slice(0, 10),
    category,
    url: `https://arxiv.org/abs/${id}`,
  };
}

async function query(params: Record<string, string>): Promise<{ total: number; papers: Paper[] }> {
  const url = `${API}?${new URLSearchParams(params)}`;
  const res = await politely(() => fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) }));
  if (!res.ok) throw new Error(`arXiv: HTTP ${res.status}`);
  const feed = parser.parse(await res.text())?.feed ?? {};
  return {
    total: Number(feed["opensearch:totalResults"]?.["#text"] ?? feed["opensearch:totalResults"] ?? 0),
    papers: list(feed.entry as Record<string, unknown> | Record<string, unknown>[]).filter((e) => e.title).map(toPaper),
  };
}

/**
 * arXiv matches accented and plain spellings separately: "Schrodinger" misses every title spelled
 * "Schrödinger". These are the names people usually type without their accents.
 */
const ACCENTED: Record<string, string> = {
  schrodinger: "schrödinger", holder: "hölder", poincare: "poincaré", frechet: "fréchet", godel: "gödel",
  erdos: "erdős", cech: "čech", kahler: "kähler", mobius: "möbius", bezier: "bézier", levy: "lévy",
  cramer: "cramér", gateaux: "gâteaux", lowner: "löwner", ruelle: "ruelle", turan: "turán",
};
const plain = (w: string) => w.normalize("NFD").replace(/\p{Diacritic}/gu, "");

/** One word as an arXiv clause, matching its accented and plain spellings. Hyphenated words stay a phrase. */
function term(word: string): string {
  const w = word.replace(/[^\p{L}\p{N}-]/gu, "").toLowerCase();
  const parts = w.split("-").filter(Boolean);
  const spell = (ps: string[]) => (ps.length > 1 ? `all:"${ps.join("-")}"` : `all:${ps[0]}`);
  const variants = new Set([
    spell(parts),
    spell(parts.map(plain)),
    spell(parts.map((p) => ACCENTED[plain(p)] ?? p)),
  ]);
  return variants.size > 1 ? `(${[...variants].join(" OR ")})` : [...variants][0];
}

export async function searchArxiv(
  text: string,
  opts: { start?: number; max?: number; sort?: "relevance" | "submittedDate" } = {},
): Promise<{ total: number; papers: Paper[] }> {
  // A pasted id or URL looks up that paper; plain words search everything.
  const id = parseArxivId(text);
  if (id && text.trim().length <= id.length + 40) return query({ id_list: id });
  const words = text.trim().split(/\s+/).filter((w) => w.replace(/[^\p{L}\p{N}]/gu, "").length > 0);
  if (!words.length) return { total: 0, papers: [] };
  const params = {
    start: String(opts.start ?? 0),
    max_results: String(Math.min(opts.max ?? 10, 30)),
    sortBy: opts.sort ?? "relevance",
    sortOrder: "descending",
  };
  // Every word must match. If that finds nothing, settle for any of them, best matches first.
  const strict = await query({ ...params, search_query: words.map(term).join(" AND ") });
  if (strict.total > 0 || words.length === 1) return strict;
  return query({ ...params, sortBy: "relevance", search_query: words.map(term).join(" OR ") });
}

export async function arxivPaper(id: string): Promise<Paper | null> {
  return (await query({ id_list: id })).papers[0] ?? null;
}

/** A paper's PDF: from the cache, or fetched once from arXiv. */
export async function arxivPdf(id: string): Promise<Buffer> {
  const file = path.join(PDF_DIR, `${id.replace(/\//g, "_")}.pdf`);
  try {
    return await readFile(file);
  } catch {}
  const res = await politely(() =>
    fetch(`https://arxiv.org/pdf/${id}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) }),
  );
  if (!res.ok) throw new Error(`arXiv PDF: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 4).toString() !== "%PDF") throw new Error("arXiv didn't return a PDF for that id");
  await mkdir(PDF_DIR, { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}
