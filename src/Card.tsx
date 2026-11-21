import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CardItem, CardStage, FoundSource } from "../shared/canvas.ts";
import { SemShapes } from "./SemShapes.tsx";

const STAGE_TEXT: Record<CardStage, string> = {
  reading: "Reading your selection…",
  searching: "Looking for good material…",
  writing: "Writing an explanation from what was found…",
  checking: "Checking it doesn't climb…",
  done: "",
  failed: "",
};

const FACETS = [
  ["why", "Why it exists"],
  ["what", "What it is"],
  ["how", "How it's used here"],
  ["name", "The name"],
] as const;

const domain = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Turns [n] markers into links to the found source. */
function withCitations(text: string, sources: FoundSource[]): ReactNode[] {
  return text.split(/(\[\d+\])/g).map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    const src = m && sources.find((s) => s.n === Number(m[1]));
    if (!src) return part;
    return (
      <a key={i} className="cite" href={src.url} target="_blank" rel="noreferrer" title={src.title}>
        {src.n}
      </a>
    );
  });
}

export function Card(props: {
  card: CardItem;
  lit: boolean;
  onHover: (on: boolean) => void;
  onHeight: (h: number) => void;
  onDescend: (text: string, clientY: number) => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const { card, onHeight } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{ text: string; top: number; clientY: number } | null>(null);

  // The parent passes a fresh callback each render; observe once and call the latest.
  const heightCb = useRef(onHeight);
  heightCb.current = onHeight;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => heightCb.current(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    const el = ref.current;
    if (!sel || !text || !el || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
      setPicked(null);
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const scale = box.height / el.offsetHeight || 1;
    setPicked({ text: text.slice(0, 200), top: (r.bottom - box.top) / scale + 6, clientY: r.top });
  };

  const sources = card.sources ?? [];
  const busy = card.stage !== "done" && card.stage !== "failed";

  return (
    <div
      ref={ref}
      className={`card-item ${props.lit ? "lit" : ""}`}
      style={{ left: card.x, top: card.y, width: card.w }}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
      onMouseUp={onMouseUp}
    >
      <div className="card-head">
        {/* With a Sem, the subject is drawn as the diagram's document title instead. */}
        <h3>{card.sem ? "" : (card.subject ?? (card.stage === "reading" ? "…" : "Explanation"))}</h3>
        {card.climb !== undefined && (
          <span
            className={`badge ${card.climb < 0.5 ? "ok" : "fail"}`}
            title="System One check: does this explanation lean on terms more specialized than its subject?"
          >
            {card.climb < 0.5 ? "descends" : "may climb"} · {Math.round((1 - card.climb) * 100)}%
            {card.rewritten ? " · rewritten once" : ""}
          </span>
        )}
        <button
          type="button"
          className="remove-btn"
          title="Remove this card and the cards below it (Ctrl+Z brings it back)"
          onClick={props.onRemove}
        >
          ×
        </button>
      </div>
      {card.transcription && card.transcription !== card.subject && <div className="transcription">{card.transcription}</div>}

      {busy && (
        <p className="muted card-stage">
          <span className="spinner" /> {STAGE_TEXT[card.stage]}
        </p>
      )}
      {card.stage === "failed" && (
        <div className="card-error">
          <p className="fail small">{card.error ?? "Something went wrong."}</p>
          <button type="button" className="secondary" onClick={props.onRetry}>
            ↻ Retry
          </button>
        </div>
      )}

      {card.sem && (
        <SemShapes title={card.subject ?? "Explanation"} sem={card.sem} render={(t) => withCitations(t, sources)} />
      )}

      {!card.sem &&
        card.facets &&
        FACETS.map(([key, label]) =>
          card.facets![key] ? (
            <section key={key} className="facet">
              <h4>{label}</h4>
              <p>{withCitations(card.facets![key], sources)}</p>
            </section>
          ) : null,
        )}

      {sources.length > 0 && (
        <section className="found">
          <h4>Found by the librarian</h4>
          <ol>
            {sources.map((s) => (
              <li key={s.n} value={s.n}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title || domain(s.url)}
                </a>{" "}
                <span className="muted small">
                  {domain(s.url)} · {s.searcher}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {picked && (
        <button
          type="button"
          className="descend"
          style={{ top: picked.top }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            props.onDescend(picked.text, picked.clientY);
            setPicked(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          Explain “{picked.text.length > 40 ? `${picked.text.slice(0, 40)}…` : picked.text}”
        </button>
      )}
    </div>
  );
}
