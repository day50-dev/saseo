import { type ReactNode, useEffect, useRef, useState } from "react";
import { type CardItem, type CardStage, type FoundSource, REGISTERS, type RegisterNote, type Sem } from "../shared/canvas.ts";
import { SemShapes } from "./SemShapes.tsx";

const STAGE_TEXT: Record<CardStage, string> = {
  reading: "Working out what you selected…",
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Marks the register of an explanation's own words (principle 9): terms of art read as strict
 * terms, and everyday stand-ins say which real term they stand for. Citations render inside.
 */
function withRegister(text: string, sem: Sem, sources: FoundSource[]): ReactNode[] {
  const marks = new Map<string, { kind: "term" | "standin"; concept?: string }>();
  for (const t of sem.terms ?? []) if (t.length > 1) marks.set(t.toLowerCase(), { kind: "term" });
  for (const s of sem.standIns ?? []) if (s.phrase.length > 1) marks.set(s.phrase.toLowerCase(), { kind: "standin", concept: s.concept });
  if (!marks.size) return withCitations(text, sources);
  // Longest first, so "magnetic field" wins over "field".
  const pattern = new RegExp(`(${[...marks.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`, "gi");
  return text.split(pattern).map((part, i) => {
    const m = marks.get(part.toLowerCase());
    if (!m) return <span key={i}>{withCitations(part, sources)}</span>;
    return m.kind === "term" ? (
      <span key={i} className="sem-term" title="Term of art: a technical term with a strict definition. Select it to go further down.">
        {part}
      </span>
    ) : (
      <span key={i} className="sem-standin" title={`Plain-language stand-in for: ${m.concept}`}>
        {part}
        <span className="sem-standin-for">{m.concept}</span>
      </span>
    );
  });
}

export function Card(props: {
  card: CardItem;
  lit: boolean;
  onHover: (on: boolean) => void;
  onHeight: (h: number) => void;
  onDescend: (text: string, context: string, clientY: number) => void;
  onRemove: () => void;
  onRetry: () => void;
  /** Pointer down on the header: start moving this card and the cards below it. */
  onGrab: (e: React.PointerEvent) => void;
  moving: boolean;
  /** How many cards are folded away below this one while it's collapsed. */
  foldedCount: number;
  onToggleCollapse: () => void;
}) {
  const { card, onHeight } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{ text: string; context: string; top: number; clientY: number } | null>(null);

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

  // Only the explanation itself can be selected to go further down: not the header, badge or buttons.
  const explainRef = useRef<HTMLDivElement>(null);

  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    const el = ref.current;
    const area = explainRef.current;
    if (!sel || !text || !el || !area || sel.rangeCount === 0 || !area.contains(sel.anchorNode) || !area.contains(sel.focusNode)) {
      setPicked(null);
      return;
    }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const scale = box.height / el.offsetHeight || 1;
    // The line the words sit in tells the librarian what they refer to.
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    const line = node?.closest(".sem-step, .sem-desc, .sem-part, .sem-together, .sem-aside, .facet p");
    const context = (line?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    setPicked({ text: text.slice(0, 200), context, top: (r.bottom - box.top) / scale + 6, clientY: r.top });
  };

  const sources = card.sources ?? [];
  const busy = card.stage !== "done" && card.stage !== "failed";

  return (
    <div
      ref={ref}
      className={`card-item ${props.lit ? "lit" : ""} ${props.moving ? "moving" : ""}`}
      style={{ left: card.x, top: card.y, width: card.w }}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
      onMouseUp={onMouseUp}
      // The card's padding is a handle too, so there's always somewhere to grab.
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onGrab(e);
      }}
    >
      <div
        className="card-head"
        title="Drag to move this card and the cards below it"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button, a")) return;
          props.onGrab(e);
        }}
      >
        <button
          type="button"
          className="fold-btn"
          aria-expanded={!card.collapsed}
          title={card.collapsed ? "Expand this card and the cards below it" : "Collapse this card and the cards below it"}
          onClick={props.onToggleCollapse}
        >
          {card.collapsed ? "▸" : "▾"}
        </button>
        {/* With a Sem, the subject is drawn as the diagram's document title instead, unless collapsed. */}
        <h3>{card.sem && !card.collapsed ? "" : (card.subject ?? (card.stage === "reading" ? "…" : "Explanation"))}</h3>
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
      {card.collapsed ? (
        <p className="folded-count">
          {props.foldedCount ? `${props.foldedCount} ${props.foldedCount === 1 ? "card" : "cards"} folded below` : "Collapsed"}
          {busy ? ` · ${STAGE_TEXT[card.stage]}` : ""}
        </p>
      ) : (
      <>
      {card.register && <RegisterBanner note={card.register} />}
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

      <div ref={explainRef} className="card-explanation">
      {card.sem && (
        <SemShapes
          title={card.subject ?? "Explanation"}
          sem={card.sem}
          render={(t) => withRegister(t, card.sem!, sources)}
          onTitlePointerDown={props.onGrab}
        />
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
      </div>

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

      </>
      )}

      {picked && (
        <button
          type="button"
          className="descend"
          style={{ top: picked.top }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            props.onDescend(picked.text, picked.context, picked.clientY);
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

/** Says up front whether the selected words were a strict term or casual language (principle 9). */
function RegisterBanner({ note }: { note: RegisterNote }) {
  const r = REGISTERS[note.register];
  const loose = note.register === "casual" || note.register === "notation";
  return (
    <div className={`register-banner reg-${note.register}`}>
      <span className="register-label">{r.label}</span> “{note.text}” is {r.gloss}
      {note.field ? `, borrowed from ${note.field}` : ""}.
      {note.means && (
        <div className="register-means">
          {loose ? "What's meant: " : ""}
          {note.means}
        </div>
      )}
    </div>
  );
}
