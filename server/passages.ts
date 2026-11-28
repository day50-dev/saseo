// Finding the passages of a long text (a whole paper) that bear on a question, so the librarian is
// given those instead of the first few pages. Two searches, merged: keywords (BM25), which catch a
// paper's exact terms ("Dual-SVID") and its formulas, and meaning, by embeddings, which catch the
// same idea in other words. Embedding a paper takes a minute or so, so it runs in the background
// and is kept on disk; until it's done, keywords alone answer.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { paragraphs } from "../shared/canvas.ts";
import { DATA_DIR } from "./canvas.ts";
import { loadConfig } from "./config.ts";

const DIR = path.join(DATA_DIR, "passages");
/** About a few hundred tokens: long enough to carry an argument, short enough to be specific. */
const PASSAGE_CHARS = 1500;
/** qwen3-embedding takes a task line for the query (not for the passages). */
const QUERY_TASK = "Given a question or topic, retrieve the passages of a document that answer it or discuss it";

export interface Passage {
  /** The section it's in, as its heading reads. */
  section: string;
  text: string;
  /** Its paragraphs in the text, first and last. */
  paras: [number, number];
  /** The pages it's on, from 1 (empty when not known). */
  pages: number[];
}

interface Kept {
  model: string;
  /** Each passage's vector, as base64 of its float32s, or "" while not embedded yet. */
  vectors: string[];
}

/** A text cut into passages: paragraphs gathered up to PASSAGE_CHARS, never across a heading. */
export function passagesOf(text: string, pageOf: number[] = []): Passage[] {
  const paras = paragraphs(text);
  const out: Passage[] = [];
  let section = "";
  let cur: Passage | null = null;
  const close = () => {
    if (cur?.text) out.push(cur);
    cur = null;
  };
  paras.forEach((p, i) => {
    if (p.startsWith("## ")) {
      close();
      section = p.slice(3).trim();
      return;
    }
    if (/^!\[/.test(p)) return;
    if (cur && cur.text.length + p.length > PASSAGE_CHARS) close();
    if (!cur) cur = { section, text: "", paras: [i, i], pages: [] };
    cur.text = cur.text ? `${cur.text}\n\n${p}` : p;
    cur.paras[1] = i;
    const page = pageOf[i];
    if (page && !cur.pages.includes(page)) cur.pages.push(page);
  });
  close();
  return out;
}

const STOP = new Set("the and for are but not you all any can had her was one our out has his how its may new now see two who did get let put say she too use that this with from they will have been were when what which their there would about into than then them these some could other more also such only over most very after where while those being both each because through between under same".split(" "));

const tokens = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));

/** BM25 scores of every passage for a query. */
export function keywordScores(passages: Passage[], query: string): number[] {
  const docs = passages.map((p) => tokens(`${p.section} ${p.text}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tokens(query))];
  const k1 = 1.2;
  const b = 0.75;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return score;
  });
}

/** One text's vector from the embeddings endpoint, or null when there's none set up. */
export async function embed(text: string, query = false): Promise<number[] | null> {
  const { embed: e } = await loadConfig();
  if (!e.baseUrl || !e.model) return null;
  const res = await fetch(`${e.baseUrl.replace(/\/+$/, "")}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: e.model, prompt: query ? `Instruct: ${QUERY_TASK}\nQuery: ${text}` : text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`The embeddings endpoint answered HTTP ${res.status}`);
  const v = ((await res.json()) as { embedding?: number[] }).embedding;
  if (!Array.isArray(v) || !v.length) throw new Error("The embeddings endpoint sent no vector");
  return v;
}

const toB64 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const fromB64 = (s: string) => {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

const keyOf = (passages: Passage[]) => createHash("sha256").update(passages.map((p) => p.text).join("\u0000")).digest("hex").slice(0, 24);

async function load(key: string, model: string, n: number): Promise<Kept> {
  try {
    const k = JSON.parse(await readFile(path.join(DIR, `${key}.json`), "utf8")) as Kept;
    if (k.model === model && k.vectors.length === n) return k;
  } catch {}
  return { model, vectors: Array(n).fill("") };
}

async function save(key: string, kept: Kept) {
  await mkdir(DIR, { recursive: true });
  const file = path.join(DIR, `${key}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(kept));
  await rename(`${file}.tmp`, file);
}

// One embedding at a time across the whole server: the endpoint doesn't go faster in parallel,
// and a reader's question shouldn't wait behind a paper's worth of passages.
const embedding = new Map<string, Promise<void>>();
let queue: Promise<unknown> = Promise.resolve();

/** Embeds a text's passages in the background (once; kept on disk). Resolves when they're all done. */
export function embedPassages(passages: Passage[]): Promise<void> {
  const key = keyOf(passages);
  let run = embedding.get(key);
  if (run) return run;
  run = (async () => {
    const { embed: e } = await loadConfig();
    if (!e.baseUrl || !e.model) return;
    const kept = await load(key, e.model, passages.length);
    let since = 0;
    for (let i = 0; i < passages.length; i++) {
      if (kept.vectors[i]) continue;
      const p = passages[i];
      const v = await (queue = queue.catch(() => {}).then(() => embed(`${p.section ? `${p.section}\n\n` : ""}${p.text}`)));
      if (!v) return;
      kept.vectors[i] = toB64(v as number[]);
      if (++since >= 8) (await save(key, kept), (since = 0));
    }
    await save(key, kept);
  })().finally(() => embedding.delete(key));
  embedding.set(key, run);
  run.catch((err) => console.warn("embedding passages:", err instanceof Error ? err.message : err));
  return run;
}

/**
 * The passages that best answer a query, best first: keyword and meaning rankings merged
 * (reciprocal rank fusion). Passages not embedded yet still count by their keywords.
 */
export async function searchPassages(passages: Passage[], query: string, k = 8): Promise<Passage[]> {
  if (!passages.length || !query.trim()) return passages.slice(0, k);
  const rank = (scores: number[]) => {
    const order = scores.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
    const r = new Map<number, number>();
    order.forEach(([, i], n) => r.set(i, n));
    return r;
  };
  const lists = [rank(keywordScores(passages, query))];
  try {
    const { embed: e } = await loadConfig();
    const kept = e.baseUrl ? await load(keyOf(passages), e.model, passages.length) : null;
    if (kept?.vectors.some(Boolean)) {
      const q = await embed(query, true);
      if (q) lists.push(rank(kept.vectors.map((s) => (s ? cosine(q, fromB64(s)) : 0))));
    }
  } catch (err) {
    console.warn("searching passages by meaning:", err instanceof Error ? err.message : err);
  }
  const fused = passages.map((_, i) => lists.reduce((sum, r) => sum + (r.has(i) ? 1 / (60 + r.get(i)!) : 0), 0));
  return fused
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([, i]) => passages[i]);
}

/** Passages as the librarian is shown them: each with its section and pages, so it can say "p. 7". */
export function passageText(passages: Passage[]): string {
  return passages
    .map((p) => `[${p.pages.length ? `p. ${p.pages.join(", ")}` : "page unknown"}${p.section ? `; ${p.section}` : ""}]\n${p.text}`)
    .join("\n\n---\n\n");
}
