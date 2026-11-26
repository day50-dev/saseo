// A notebook beside the canvas: an example to run and play with, found online (credited) or, when
// none could be found, written by the librarian (and saying so). Python runs in the browser.
import Prism from "prismjs";
import "prismjs/components/prism-python";
import "prismjs/components/prism-julia";
import "prismjs/components/prism-r";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CardItem, NotebookCell } from "../shared/canvas.ts";
import { withMath } from "./MathText.tsx";
import { type CellOutput, onPythonStatus, restartPython, runPython, warmPython } from "./python.ts";

const STAGES: Record<string, string> = {
  reading: "Getting started…",
  searching: "Looking for an example notebook online…",
  writing: "None found that fits; writing one…",
};

const newCellId = () => Math.random().toString(36).slice(2, 10);

/** Inline markdown: `code`, **bold**, *italic*, [links](url), and math. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let k = 0;
  const math = (t: string) => <span key={k++}>{withMath(t)}</span>;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(math(text.slice(last, m.index)));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{withMath(t.slice(2, -2))}</strong>);
    else if (m[3]) out.push(<em key={k++}>{withMath(t.slice(1, -1))}</em>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(
        <a key={k++} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    }
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(math(text.slice(last)));
  return out;
}

/** Enough markdown for notebooks: headings, lists, code blocks, paragraphs, math. */
function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/<br\s*\/?>/gi, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "))}</p>);
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push(<pre key={blocks.length}>{code.join("\n")}</pre>);
    } else if (/^\s*\$\$/.test(l)) {
      flush();
      const tex: string[] = [l.replace(/^\s*\$\$/, "")];
      if (!/\$\$\s*$/.test(l) || l.trim() === "$$") for (i++; i < lines.length && !/\$\$/.test(lines[i]); i++) tex.push(lines[i]);
      if (i < lines.length && lines[i] !== l) tex.push(lines[i].replace(/\$\$.*$/, ""));
      blocks.push(<div key={blocks.length} className="nb-display">{withMath(`\\[${tex.join(" ").replace(/\$\$\s*$/, "")}\\]`)}</div>);
    } else if (/^#{1,6}\s/.test(l)) {
      flush();
      const level = /^#+/.exec(l)![0].length;
      const H = (`h${Math.min(6, level + 2)}`) as "h3";
      blocks.push(<H key={blocks.length}>{inline(l.replace(/^#+\s*/, ""))}</H>);
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      if (para.length) flush();
      list.push(l.replace(/^\s*([-*+]|\d+\.)\s+/, ""));
    } else if (!l.trim() || /^-{3,}\s*$/.test(l)) {
      flush();
    } else {
      if (list.length) flush();
      para.push(l.trim());
    }
  }
  flush();
  return <div className="nb-md">{blocks}</div>;
}

/** What a cell showed its author, kept from the original notebook. */
function Saved({ saved }: { saved: NonNullable<NotebookCell["saved"]> }) {
  return (
    <div className="nb-out nb-saved" title="As it ran for the notebook's author">
      {saved.map((o, i) => (o.image ? <img key={i} src={`data:image/png;base64,${o.image}`} alt="Plot" /> : <pre key={i}>{(o.text ?? "").replace(/\n$/, "")}</pre>))}
    </div>
  );
}

function Output({ out }: { out: CellOutput | "running" | undefined }) {
  if (!out) return null;
  if (out === "running")
    return (
      <div className="nb-out muted small">
        <span className="spinner" /> Running…
      </div>
    );
  const empty = !out.stdout && !out.stderr && !out.result && !out.images.length;
  if (empty) return null;
  return (
    <div className="nb-out">
      {out.stdout && <pre>{out.stdout.replace(/\n$/, "")}</pre>}
      {out.result && <pre className="nb-result">{out.result}</pre>}
      {out.images.map((img, i) => (
        <img key={i} src={`data:image/png;base64,${img}`} alt="Plot" />
      ))}
      {out.stderr && <pre className={out.error ? "nb-error" : "nb-warn"}>{out.stderr.replace(/\n$/, "")}</pre>}
    </div>
  );
}

/** The code, colored (HTML): Prism's grammar for the language, or plain text escaped. */
export function colored(source: string, language: string, underTextarea = true): string {
  const grammar = Prism.languages[language];
  // Under a textarea, a trailing newline needs something after it, or the copy ends a line short.
  const text = underTextarea ? `${source}\n` : source;
  return grammar ? Prism.highlight(text, grammar, language) : text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

// The code is edited in a textarea whose own letters are transparent, over a colored copy laid out
// the same way: highlighting without giving up plain, native editing.
function CodeCell({ cell, language, onChange, onRun }: { cell: NotebookCell; language: string; onChange: (s: string) => void; onRun: () => void }) {
  const html = useMemo(() => colored(cell.source, language), [cell.source, language]);
  return (
    <div className="nb-code-wrap">
      <pre className="nb-code nb-code-colors" aria-hidden dangerouslySetInnerHTML={{ __html: html }} />
      <textarea
      className="nb-code nb-code-input"
      value={cell.source}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onRun();
        } else if (e.key === "Tab") {
          e.preventDefault();
          const t = e.currentTarget;
          const { selectionStart: a, selectionEnd: b } = t;
          onChange(`${t.value.slice(0, a)}    ${t.value.slice(b)}`);
          requestAnimationFrame(() => t.setSelectionRange(a + 4, a + 4));
        }
      }}
      />
    </div>
  );
}

export function NotebookPanel(props: {
  card: CardItem;
  /** Run every cell once it's loaded (a notebook just asked for). */
  autoRun: boolean;
  onSave: (cells: NotebookCell[]) => Promise<unknown>;
  onShowCard: () => void;
  onClose: () => void;
}) {
  const { card } = props;
  const nb = card.object?.type === "notebook" ? card.object : null;
  // Python runs here; other languages (Julia, R…) show what they showed their author.
  const language = nb?.language ?? "python";
  const live = language === "python";
  const langName = language.replace(/^./, (c) => c.toUpperCase());
  const [cells, setCells] = useState<NotebookCell[]>(nb?.cells ?? []);
  const [outputs, setOutputs] = useState<Record<string, CellOutput | "running">>({});
  const [status, setStatus] = useState("");
  const [width, setWidth] = useState(() => Math.min(760, Math.round(window.innerWidth * 0.42)));
  const [editing, setEditing] = useState<string | null>(null);
  // The notebook's description, folded by default so its cells come first.
  const [about, setAbout] = useState(false);
  const ran = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  useEffect(() => onPythonStatus(setStatus), []);
  useEffect(() => {
    if (live) warmPython();
  }, [live]);

  // The notebook arrives (or changes on the server) while the panel is open: take it, unless
  // you've edited it here since.
  const dirty = useRef(false);
  const serverKey = nb ? nb.cells.map((c) => `${c.id}:${c.source.length}`).join(",") : "";
  useEffect(() => {
    dirty.current = false;
    ran.current = false;
    setOutputs({});
  }, [card.id]);
  useEffect(() => {
    if (nb && !dirty.current) setCells(nb.cells);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, serverKey]);

  const runCell = async (cell: NotebookCell) => {
    if (cell.kind !== "code") return;
    setOutputs((o) => ({ ...o, [cell.id]: "running" }));
    const out = await runPython(cell.source);
    setOutputs((o) => ({ ...o, [cell.id]: out }));
    return out;
  };
  const runAll = async () => {
    for (const cell of cellsRef.current) if (cell.kind === "code") await runCell(cell);
  };

  useEffect(() => {
    // Once its cells are in (they arrive a render after the card does).
    if (props.autoRun && live && nb && card.stage === "done" && cells.length && !ran.current) {
      ran.current = true;
      void runAll();
    }
  });

  const change = (next: NotebookCell[]) => {
    dirty.current = true;
    setCells(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void props.onSave(next), 800);
  };
  const edit = (id: string, source: string) => change(cells.map((c) => (c.id === id ? { ...c, source } : c)));
  const insertAfter = (i: number, kind: NotebookCell["kind"]) => {
    const cell = { id: newCellId(), kind, source: "" };
    change([...cells.slice(0, i + 1), cell, ...cells.slice(i + 1)]);
    setEditing(cell.id);
  };
  const remove = (id: string) => change(cells.filter((c) => c.id !== id));

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const move = (ev: PointerEvent) => setWidth(Math.max(320, Math.min(window.innerWidth - 120, w0 + (x0 - ev.clientX))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const busy = card.stage !== "done" && card.stage !== "failed";
  return (
    <aside className="nb-panel" style={{ width }} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="nb-resize" onPointerDown={startResize} title="Drag to make the notebook wider or narrower" />
      <header className="nb-head">
        <div className="nb-title">
          <strong title={`${nb?.title ?? ""}\nShow its card on the canvas`} onClick={props.onShowCard}>
            {nb?.title ?? card.request ?? "Notebook"}
          </strong>
          {nb && (
            // Where it came from, in one line; what it shows and the rest, folded away until asked for.
            <button type="button" className="nb-about-toggle small" aria-expanded={about} onClick={() => setAbout(!about)} title={about ? "Hide the details" : "Show what this notebook is and where it's from"}>
              {about ? "▾" : "▸"}{" "}
              {nb.source ? (
                <span className="muted">
                  From <span className="nb-src">{nb.source.title}</span>
                </span>
              ) : (
                <span className="nb-written">Written by the librarian</span>
              )}
              {!live && <span className="nb-written"> · {langName}, author's results</span>}
            </button>
          )}
          {nb && about && (
            <div className="nb-about small">
              {nb.source ? (
                <p>
                  Found online:{" "}
                  <a href={nb.source.url} target="_blank" rel="noreferrer">
                    {nb.source.title}
                  </a>{" "}
                  (cells kept as written)
                </p>
              ) : (
                <p className="nb-written">No example found online that fits, so the librarian wrote this one. Check it.</p>
              )}
              {nb.why && <p>{nb.why}</p>}
              {!live && (
                <p className="nb-written">
                  {langName} notebook: shown with its author's own results, since {langName} can't run in the browser.
                  {nb.source?.binder && (
                    <>
                      {" "}
                      <a href={nb.source.binder} target="_blank" rel="noreferrer">
                        Run it live on Binder
                      </a>
                    </>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="nb-tools">
          {live && (
            <>
              <button type="button" disabled={!nb} onClick={() => void runAll()} title="Run every cell, top to bottom">
                ▶ Run all
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  restartPython();
                  setOutputs({});
                }}
                title="Start Python over, with nothing defined"
              >
                Restart
              </button>
            </>
          )}
          <button type="button" className="secondary" onClick={props.onClose} title="Close the notebook (it stays on its card)">
            ✕
          </button>
        </div>
      </header>
      {status && (
        <div className="nb-status small muted">
          <span className="spinner" /> {status}
        </div>
      )}
      <div className="nb-cells">
        {busy && (
          <p className="muted">
            <span className="spinner" /> {STAGES[card.stage] ?? "Working…"}
          </p>
        )}
        {card.stage === "failed" && <p className="fail">{card.error ?? "Couldn't make the notebook."}</p>}
        {cells.map((cell, i) => (
          <div key={cell.id} className={`nb-cell ${cell.kind}`}>
            <div className="nb-gutter">
              {cell.kind === "code" && live ? (
                <button type="button" className="nb-run" title="Run this cell (Shift+Enter)" onClick={() => void runCell(cell)}>
                  ▶
                </button>
              ) : null}
            </div>
            <div className="nb-body">
              {cell.kind === "code" ? (
                <CodeCell cell={cell} language={language} onChange={(s) => edit(cell.id, s)} onRun={() => void runCell(cell)} />
              ) : editing === cell.id ? (
                <textarea className="nb-code nb-md-edit" autoFocus value={cell.source} onChange={(e) => edit(cell.id, e.target.value)} onBlur={() => setEditing(null)} />
              ) : (
                <div onDoubleClick={() => setEditing(cell.id)} title="Double-click to edit">
                  <Markdown source={cell.source} />
                </div>
              )}
              {outputs[cell.id] ? <Output out={outputs[cell.id]} /> : cell.saved ? <Saved saved={cell.saved} /> : null}
              <div className="nb-cell-tools">
                <button type="button" className="link" onClick={() => insertAfter(i, "code")}>
                  + code
                </button>
                <button type="button" className="link" onClick={() => insertAfter(i, "markdown")}>
                  + text
                </button>
                <button type="button" className="link" onClick={() => remove(cell.id)}>
                  remove
                </button>
              </div>
            </div>
          </div>
        ))}
        {nb && !cells.length && (
          <button type="button" className="secondary" onClick={() => insertAfter(-1, "code")}>
            + Add a code cell
          </button>
        )}
      </div>
    </aside>
  );
}
