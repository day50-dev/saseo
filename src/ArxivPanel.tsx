import { AddToZotero } from "./Zotero.tsx";
import { useEffect, useState } from "react";
import type { Paper } from "../shared/canvas.ts";
import { searchArxiv } from "./arxiv.ts";

/** Search arXiv, or paste an id or URL, and add chosen pages of a paper to the canvas. */
export function ArxivPanel({ onAdd, onClose, initial = "" }: { onAdd: (paper: Paper, pages: string) => Promise<void>; onClose: () => void; initial?: string }) {
  const [q, setQ] = useState(initial);
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [result, setResult] = useState<{ total: number; papers: Paper[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await searchArxiv(q, sort));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // Opened from Add with words already typed: search for them straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on opening.
  useEffect(() => {
    if (initial.trim()) void run();
  }, []);

  return (
    <div className="panel-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel arxiv-panel" role="dialog" aria-label="Add from arXiv">
        <div className="panel-head">
          <h2>Add from arXiv</h2>
          <button type="button" className="remove-btn" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <form className="row" onSubmit={run}>
          <input
            autoFocus
            value={q}
            placeholder="Search words, or paste an arXiv id or link"
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as "relevance" | "date")} title="Order results by">
            <option value="relevance">Best match</option>
            <option value="date">Newest</option>
          </select>
          <button type="submit" disabled={busy || !q.trim()}>
            {busy ? "Searching…" : "Search"}
          </button>
        </form>
        <p className="muted small">arXiv asks for a few seconds between searches, so results can take a moment.</p>
        {error && <p className="fail small">{error}</p>}
        {result && (
          <>
            <p className="muted small">{result.total.toLocaleString()} found</p>
            <ol className="paper-list">
              {result.papers.map((p) => (
                <PaperRow key={p.id} paper={p} onAdd={onAdd} />
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

/** One paper: what it is, its abstract on demand, and which pages to add. */
export function PaperRow({ paper, onAdd }: { paper: Paper; onAdd: (paper: Paper, pages: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState("1-2");
  const [state, setState] = useState<"" | "adding" | "added" | string>("");
  const authors = paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(", ")} et al.` : paper.authors.join(", ");
  return (
    <li className="paper">
      <a href={paper.url} target="_blank" rel="noreferrer" className="paper-title">
        {paper.title}
      </a>
      <div className="muted small">
        {authors} · {paper.published} · {paper.category} · {paper.id}
      </div>
      {open ? (
        <p className="small paper-abstract">{paper.summary}</p>
      ) : (
        <button type="button" className="link small" onClick={() => setOpen(true)}>
          Abstract
        </button>
      )}
      <div className="row paper-add">
        <span className="small muted">Pages</span>
        <input value={pages} onChange={(e) => setPages(e.target.value)} title="Pages to add, e.g. 1-2 or 1, 4-5" />
        <button
          type="button"
          className="secondary"
          disabled={state === "adding"}
          onClick={async () => {
            setState("adding");
            try {
              await onAdd(paper, pages);
              setState("added");
            } catch (err) {
              setState(`Couldn't add: ${err}`);
            }
          }}
        >
          {state === "adding" ? "Adding…" : state === "added" ? "Added ✓" : "Add to canvas"}
        </button>
      </div>
      {state && state !== "adding" && state !== "added" && <p className="fail small">{state}</p>}
      <AddToZotero item={{ url: paper.url, title: paper.title, authors: paper.authors, date: paper.published, abstract: paper.summary, arxiv: paper.id }} />
    </li>
  );
}
