// Example notebooks for a topic, found in the wild: code people wrote and ran is trusted over code
// a model makes up. Candidates come from the web searchers (and GitHub's own search); the model
// only chooses which notebook and which of its cells make a focused, runnable example, and the
// cells are kept word for word. Only if nothing usable turns up does the librarian write one,
// and the notebook says so.
import type { NotebookCell, NotebookSource } from "../shared/canvas.ts";
import { SEARCHER_IDS } from "../shared/providers.ts";
import { newId } from "./canvas.ts";
import { loadConfig } from "./config.ts";
import { chatJson } from "./llm.ts";
import { runSearch } from "./providers.ts";

/** Packages Python in the browser (Pyodide) can load; a notebook needing others mostly won't run. */
const RUNNABLE = new Set(
  "numpy scipy matplotlib sympy pandas sklearn networkx statsmodels PIL math cmath random itertools collections functools fractions decimal statistics time re json string textwrap operator heapq bisect copy typing dataclasses enum datetime pprint mpl_toolkits".split(
    " ",
  ),
);

interface Candidate {
  /** Where people view it. */
  page: string;
  raw: string;
  title: string;
  binder?: string;
  cells: NotebookCell[];
  imports: string[];
  /** "python", "julia", "r", "python 2"… */
  language: string;
}

/** Python 3 runs in the browser; other languages show their author's saved outputs. */
export const runsHere = (language: string) => language === "python";

/** The raw file behind a notebook link on GitHub, nbviewer or Colab; undefined if it isn't one. */
export function rawUrl(url: string): { raw: string; page: string; title: string; binder?: string } | undefined {
  const u = decodeURIComponent(url.split(/[?#]/)[0]);
  const m =
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+\.ipynb)$/i.exec(u) ??
    /^https?:\/\/(?:github\.com|nbviewer\.(?:org|jupyter\.org)\/github|colab\.research\.google\.com\/github|cocalc\.com\/github)\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.ipynb)$/i.exec(u);
  if (!m) {
    // nbviewer showing a notebook from elsewhere, or a notebook file on any site (course pages).
    const viewed = /^https?:\/\/nbviewer\.(?:org|jupyter\.org)\/(urls?)\/(.+\.ipynb)$/i.exec(u);
    const file = viewed ? `${viewed[1].toLowerCase() === "urls" ? "https" : "http"}://${viewed[2]}` : /^https?:\/\/[^?#]+\.ipynb$/i.test(u) ? url.split(/[?#]/)[0] : "";
    if (!file) return undefined;
    const name = decodeURIComponent(file.split("/").pop()!.replace(/\.ipynb$/i, ""));
    return { raw: file, page: viewed ? url : file, title: `${new URL(file).hostname}: ${name}` };
  }
  const [, owner, repo, branch, path] = m;
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return {
    raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${enc}`,
    page: `https://github.com/${owner}/${repo}/blob/${branch}/${enc}`,
    binder: `https://mybinder.org/v2/gh/${owner}/${repo}/${branch}?labpath=${encodeURIComponent(path)}`,
    title: `${owner}/${repo}: ${path.split("/").pop()!.replace(/\.ipynb$/i, "")}`,
  };
}

const text = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");

type RawOutput = { output_type?: string; text?: unknown; data?: Record<string, unknown>; ename?: string; evalue?: string };

/** What a cell showed when its author ran it: text and PNG plots, within reason. */
function savedOf(outputs: RawOutput[] | undefined): NotebookCell["saved"] {
  const out: NonNullable<NotebookCell["saved"]> = [];
  for (const o of outputs ?? []) {
    if (o.output_type === "stream") out.push({ text: text(o.text).slice(0, 8000) });
    else if (o.output_type === "error") out.push({ text: `${o.ename}: ${o.evalue}`.slice(0, 2000) });
    else if (o.data) {
      const png = o.data["image/png"];
      if (typeof png === "string" && png.length < 600_000) out.push({ image: png.replace(/\s+/g, "") });
      else if (o.data["text/plain"]) out.push({ text: text(o.data["text/plain"]).slice(0, 8000) });
    }
  }
  return out.length ? out : undefined;
}

/** Reads a notebook file into cells, with what each showed when it was run. */
export function cellsOf(nb: unknown): NotebookCell[] {
  const cells = (nb as { cells?: { cell_type?: string; source?: unknown; outputs?: RawOutput[] }[] })?.cells;
  if (!Array.isArray(cells)) return [];
  return cells.flatMap((c) => {
    if ((c.cell_type !== "code" && c.cell_type !== "markdown") || !text(c.source).trim()) return [];
    const saved = c.cell_type === "code" ? savedOf(c.outputs) : undefined;
    return [{ id: newId(), kind: c.cell_type, source: text(c.source).replace(/\s+$/, ""), ...(saved ? { saved } : {}) } as NotebookCell];
  });
}

const importsOf = (cells: NotebookCell[]) => [
  ...new Set(cells.filter((c) => c.kind === "code").flatMap((c) => [...c.source.matchAll(/^\s*(?:from|import)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]))),
];

async function fetchCandidate(link: { raw: string; page: string; title: string; binder?: string }): Promise<Candidate | undefined> {
  try {
    const r = await fetch(link.raw, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return undefined;
    const body = await r.text();
    if (body.length > 8_000_000) return undefined;
    const nb = JSON.parse(body) as { metadata?: { kernelspec?: { name?: string; language?: string }; language_info?: { name?: string; version?: string } } };
    // Course notebooks are often Julia, R or MATLAB, and old ones Python 2: only Python 3 runs here;
    // the rest show what they showed their author.
    const meta = nb.metadata ?? {};
    const cells = cellsOf(nb);
    if (!cells.some((c) => c.kind === "code")) return undefined;
    let language = String(meta.language_info?.name ?? meta.kernelspec?.language ?? meta.kernelspec?.name ?? "python").toLowerCase();
    if (/python/.test(language)) {
      const py2 =
        /python2/i.test(meta.kernelspec?.name ?? "") ||
        /^2\./.test(meta.language_info?.version ?? "") ||
        cells.some((c) => c.kind === "code" && /^\s*print\s+["'\w]/m.test(c.source) && !/^\s*print\s*\(/m.test(c.source));
      language = py2 ? "python 2" : "python";
    }
    return { ...link, cells, imports: language === "python" ? importsOf(cells) : [], language };
  } catch {
    return undefined;
  }
}

/** Notebooks in GitHub repositories about the topic, when the web searchers find none directly. */
async function fromGitHub(query: string): Promise<{ raw: string; page: string; title: string; binder?: string }[]> {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const gh = (path: string) =>
    fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "librarian" }, signal: AbortSignal.timeout(15_000) }).then((r) =>
      r.ok ? r.json() : null,
    );
  const found = (await gh(`/search/repositories?q=${encodeURIComponent(`${query} language:"Jupyter Notebook"`)}&sort=stars&per_page=3`).catch(() => null)) as {
    items?: { full_name: string; default_branch: string }[];
  } | null;
  const out: { raw: string; page: string; title: string; binder?: string }[] = [];
  for (const repo of found?.items ?? []) {
    const tree = (await gh(`/repos/${repo.full_name}/git/trees/${repo.default_branch}?recursive=1`).catch(() => null)) as { tree?: { path: string }[] } | null;
    const books = (tree?.tree ?? [])
      .map((t) => t.path)
      .filter((p) => p.endsWith(".ipynb") && !p.includes(".ipynb_checkpoints"))
      .map((p) => ({ p, score: words.filter((w) => p.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const b of books) {
      const link = rawUrl(`https://github.com/${repo.full_name}/blob/${repo.default_branch}/${b.p}`);
      if (link) out.push(link);
    }
  }
  return out;
}

const PICK = `A reader studying a topic asked for an example notebook. Below are real notebooks found online.
Choose the ONE that best gives them a clear, runnable example of what they asked for, and choose which of its
cells to keep: a focused sequence, usually 4 to 20 cells, that runs top to bottom on its own. Keep every cell
the kept code needs (imports, definitions, data it uses) and the markdown that explains it; leave out
unrelated sections, exercises, installs, and cells that need files or network access. Never rewrite cells:
you only choose them. Python notebooks marked runnable run live for the reader, so prefer them; a notebook in
another language (Julia, R…) or needing other packages is shown with its author's own outputs, which is fine
when it fits what they asked clearly better.
If none of them fits what they asked for, pick -1.
Return JSON only: {"pick": 0, "cells": [0, 1, 2], "title": "a short title for the example", "why": "one sentence: what it shows"}`;

const WRITE = `A reader studying a topic asked for an example notebook and none could be found online. Write a short one:
4 to 10 cells alternating short markdown explanations and Python code that runs top to bottom in a browser
(Pyodide). Use only the standard library, numpy, scipy, matplotlib, sympy, pandas, scikit-learn or networkx. No
files, no network, no installs. Show results: print them, or plot with matplotlib.
Return JSON only: {"title": "...", "why": "one sentence: what it shows", "cells": [{"kind": "markdown" | "code", "source": "..."}]}`;

export interface FoundNotebook {
  title: string;
  language: string;
  why?: string;
  cells: NotebookCell[];
  source?: NotebookSource;
}

/** An example notebook for `request` (about `about`): found if at all possible, written if not. */
export async function exampleNotebook(request: string, about: string, onStage?: (s: "searching" | "writing") => void): Promise<FoundNotebook> {
  const config = await loadConfig();
  onStage?.("searching");
  const enabled = SEARCHER_IDS.filter((id) => config.searchers[id].enabled);
  const links = new Map<string, { raw: string; page: string; title: string; binder?: string }>();
  if (enabled.length) {
    for (const q of [`${request} jupyter notebook ipynb`, `${request} python notebook example ipynb github`]) {
      const results = await runSearch(config, q, enabled, 10).catch(() => ({}));
      for (const r of Object.values(results)) for (const h of r?.ok ? r.hits : []) {
        const link = rawUrl(h.url);
        if (link) links.set(link.raw, link);
      }
      if (links.size >= 4) break;
    }
  }
  if (links.size < 2) for (const link of await fromGitHub(request).catch(() => [])) links.set(link.raw, link);

  const candidates = (await Promise.all([...links.values()].slice(0, 6).map(fetchCandidate))).filter((c): c is Candidate => !!c);
  if (candidates.length) {
    const listing = candidates
      .map((c, i) => {
        const runnable = runsHere(c.language) && c.imports.every((m) => RUNNABLE.has(m));
        const cells = c.cells
          .slice(0, 80)
          .map((cell, j) => `  [${j}] ${cell.kind}: ${cell.source.replace(/\s+/g, " ").slice(0, 140)}`)
          .join("\n");
        const how = runnable ? "runnable" : runsHere(c.language) ? "needs other packages" : `${c.language}: shown with saved outputs`;
        return `Notebook ${i}: ${c.title}\nLanguage: ${c.language}; imports: ${c.imports.join(", ") || "none"} (${how})\nCells:\n${cells}`;
      })
      .join("\n\n");
    try {
      const r = await chatJson<{ pick?: number; cells?: number[]; title?: string; why?: string }>(config.llm, [
        { role: "system", content: PICK },
        { role: "user", content: `They asked for: ${request}\nThe card it's about: ${about.slice(0, 1500)}\n\n${listing}` },
      ]);
      if (process.env.NOTEBOOK_DEBUG) console.log("candidates", candidates.map((x) => x.title), "pick", r);
      const c = typeof r.pick === "number" ? candidates[r.pick] : undefined;
      if (c) {
        const keep = [...new Set((r.cells ?? []).filter((n) => Number.isInteger(n) && n >= 0 && n < c.cells.length))].sort((a, b) => a - b);
        const cells = (keep.length ? keep.map((n) => c.cells[n]) : c.cells.slice(0, 20)).map((cell) => ({ ...cell, id: newId() }));
        return {
          title: String(r.title || c.title).slice(0, 120),
          language: c.language,
          why: r.why ? String(r.why).slice(0, 300) : undefined,
          cells,
          source: { url: c.page, title: c.title, ...(c.binder ? { binder: c.binder } : {}) },
        };
      }
    } catch {
      // Fall through to writing one.
    }
  }

  onStage?.("writing");
  const w = await chatJson<{ title?: string; why?: string; cells?: { kind?: string; source?: string }[] }>(config.llm, [
    { role: "system", content: WRITE },
    { role: "user", content: `They asked for: ${request}\nThe card it's about: ${about.slice(0, 1500)}` },
  ]);
  const cells = (w.cells ?? [])
    .filter((c) => typeof c.source === "string" && c.source.trim())
    .map((c) => ({ id: newId(), kind: c.kind === "markdown" ? "markdown" : "code", source: c.source!.trim() }) as NotebookCell);
  if (!cells.length) throw new Error("Couldn't find or write an example notebook. Try asking differently.");
  return { title: String(w.title || request).slice(0, 120), language: "python", why: w.why ? String(w.why).slice(0, 300) : undefined, cells };
}
