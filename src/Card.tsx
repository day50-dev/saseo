import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type CardItem,
  type CardStage,
  type Clarify,
  type FoundSource,
  type Paper,
  paragraphs,
  REGISTERS,
  type RegisterNote,
  type Sem,
} from "../shared/canvas.ts";
import { PaperRow } from "./ArxivPanel.tsx";
import { clearMarks, findPhrases, setMarks } from "./marks.ts";
import { looksLikeTex, selectedText, Tex, textWithTex, withMath } from "./MathText.tsx";
import { SemShapes } from "./SemShapes.tsx";

const STAGE_TEXT: Record<CardStage, string> = {
  reading: "Working out what you selected…",
  asking: "Has a question for you",
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
  return withMath(text, (plain) => citations(plain, sources));
}

function citations(text: string, sources: FoundSource[]): ReactNode[] {
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
  // Terms are marked only in the words, never inside a formula.
  return withMath(text, (plain) => registerMarks(plain, sem, sources));
}

function registerMarks(text: string, sem: Sem, sources: FoundSource[]): ReactNode[] {
  const marks = new Map<string, { kind: "term" | "standin"; concept?: string }>();
  for (const t of sem.terms ?? []) if (t.length > 1) marks.set(t.toLowerCase(), { kind: "term" });
  for (const s of sem.standIns ?? []) if (s.phrase.length > 1) marks.set(s.phrase.toLowerCase(), { kind: "standin", concept: s.concept });
  if (!marks.size) return citations(text, sources);
  // Longest first, so "magnetic field" wins over "field".
  const pattern = new RegExp(`(${[...marks.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`, "gi");
  return text.split(pattern).map((part, i) => {
    const m = marks.get(part.toLowerCase());
    if (!m) return <span key={i}>{citations(part, sources)}</span>;
    return m.kind === "term" ? (
      <span key={i} className="sem-term" title="Term of art: a technical term with a strict definition. Click it to have it explained.">
        {part}
      </span>
    ) : (
      <span key={i} className="sem-standin" data-explain={m.concept} title={`Plain-language stand-in for: ${m.concept}. Click to have that explained.`}>
        {part}
        <span className="sem-standin-for">{m.concept}</span>
      </span>
    );
  });
}

export type Side = "left" | "right" | "top" | "bottom";

export function Card(props: {
  card: CardItem;
  lit: boolean;
  onHover: (on: boolean) => void;
  onHeight: (h: number) => void;
  onDescend: (text: string, context: string, clientY: number) => void;
  onRemove: () => void;
  onRetry: () => void;
  /** Answers the librarian's question; "" means just explain. */
  onAnswer: (answer: string) => void;
  /** Sends a message in this card's conversation. */
  onAsk: (text: string) => void;
  /** Brings an object a conversation made into view. */
  onFocus: (id: string) => void;
  /** Adds the first pages of a paper from a papers card to the canvas. */
  onAddPaper: (paper: Paper) => Promise<void>;
  /** Pointer down on the header: start moving this card and the cards below it. */
  onGrab: (e: React.PointerEvent) => void;
  moving: boolean;
  /** Stacking position: higher draws on top. */
  z: number;
  selected: boolean;
  /** How many cards are folded away below this one while it's collapsed. */
  foldedCount: number;
  onToggleCollapse: () => void;
  /** Pointer down on a side port: start dragging a connection to ask how this relates to another card. */
  onPortDown: (side: Side, e: React.PointerEvent) => void;
  /** A connection is being dragged from another card: this one can be dropped on. */
  linking: boolean;
  /** For a relation card: the names of the two things it relates. */
  relatesNames?: string[];
  /** Words in this card that already have a card of their own. */
  explained: string[];
  /** Words in this card being explained right now. */
  explaining: string[];
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

  // Only the explanation and the conversation can be selected to go further down: not the
  // header, badge or buttons.
  const explainRef = useRef<HTMLDivElement>(null);
  // A linked page shows as shapes or as its text, and each links to the other.
  const pageCard = card.origin?.kind === "page" && card.stage === "done";
  const [view, setView] = useState<"shapes" | "page">("shapes");
  const showShapes = Boolean(card.sem) && (!pageCard || view === "shapes");
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash || !showShapes) return;
    const el = explainRef.current?.querySelector(`[data-a="${flash}"]`);
    el?.classList.add("flash");
    const t = setTimeout(() => (el?.classList.remove("flash"), setFlash(null)), 1800);
    return () => clearTimeout(t);
  }, [flash, showShapes]);
  const chatRef = useRef<HTMLDivElement>(null);
  // Mark what has been explained, and what's on its way, right where it was selected.
  const markKey = JSON.stringify([props.explained, props.explaining]);
  useEffect(() => {
    const roots = [explainRef.current, chatRef.current];
    setMarks(card.id, { explained: findPhrases(roots, props.explained), explaining: findPhrases(roots, props.explaining) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markKey, card, view, showShapes]);
  useEffect(() => () => clearMarks(card.id), [card.id]);
  const inText = (n: Node | null) => Boolean(n && (explainRef.current?.contains(n) || chatRef.current?.contains(n)));

  const onMouseUp = () => {
    const sel = window.getSelection();
    const text = sel ? selectedText(sel).replace(/\s+/g, " ").trim() : "";
    const el = ref.current;
    if (!sel || !text || !el || sel.rangeCount === 0 || !inText(sel.anchorNode) || !inText(sel.focusNode)) {
      setPicked(null);
      return;
    }
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    pick(text, sel.getRangeAt(0).getBoundingClientRect(), node);
  };

  /** Offers to explain some words, with a button just under where they sit. */
  const pick = (text: string, r: DOMRect, node: Element | null | undefined) => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const scale = box.height / el.offsetHeight || 1;
    // The line the words sit in tells the librarian what they refer to.
    const line = node?.closest(".sem-step, .sem-desc, .sem-part, .sem-together, .sem-aside, .facet p, .chat-text, .source-para");
    const context = (line ? textWithTex(line) : "").replace(/\s+/g, " ").trim().slice(0, 500);
    setPicked({ text: text.slice(0, 200), context, top: (r.bottom - box.top) / scale + 6, clientY: r.top });
  };

  // A click on a marked term (or a stand-in) offers to explain it, without having to select it.
  const onClick = (e: React.MouseEvent) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".sem-term, .sem-standin");
    if (!t || !inText(t) || !window.getSelection()?.isCollapsed) return;
    const text = t.dataset.explain ?? t.textContent ?? "";
    if (text.trim()) pick(text.trim(), t.getBoundingClientRect(), t);
  };

  const sources = card.sources ?? [];
  const busy = card.stage !== "done" && card.stage !== "failed";

  return (
    <div
      ref={ref}
      data-card-id={card.id}
      className={`card-item ${props.lit ? "lit" : ""} ${props.moving ? "moving" : ""} ${props.linking ? "link-target" : ""} ${card.relates ? "relation" : ""} ${props.selected ? "selected" : ""}`}
      style={{ left: card.x, top: card.y, width: card.w, zIndex: props.moving ? 100000 : props.z }}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
      onMouseUp={onMouseUp}
      onClick={onClick}
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
        <h3>{showShapes && !card.collapsed ? "" : (card.subject ?? (card.stage === "reading" ? "…" : "Explanation"))}</h3>
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
      {/* What this card is about, said plainly and big enough to see at a glance. */}
      {(card.selection || card.transcription) && (
        <div className="asked">
          <span className="asked-label">{card.selection ? "You selected" : "Your box reads"}</span>
          <div className="asked-text">{card.selection ? withMath(card.selection) : transcription(card.transcription!)}</div>
        </div>
      )}
      {props.relatesNames && (
        <div className="relation-banner">
          You asked how these relate: <strong>{props.relatesNames[0]}</strong> ⟷ <strong>{props.relatesNames[1]}</strong>
        </div>
      )}
      {card.register && <RegisterBanner note={card.register} />}
      {card.terms && card.terms.length > 0 && <TermsList terms={card.terms} />}

      {card.clarify && card.stage === "asking" && <AskView clarify={card.clarify} onAnswer={props.onAnswer} />}
      {card.clarify?.answer && card.stage !== "asking" && (
        <p className="small muted told">
          You told the librarian: {card.clarify.answer}
        </p>
      )}
      {busy && card.stage !== "asking" && (
        <p className="muted card-stage">
          <span className="spinner" /> {card.origin?.kind === "page" ? "Reading the page…" : STAGE_TEXT[card.stage]}
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
      {pageCard && (
        <div className="view-switch" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className={view === "shapes" ? "on" : ""} disabled={!card.sem} onClick={() => setView("shapes")}>
            Shapes
          </button>
          <button type="button" className={view === "page" ? "on" : ""} onClick={() => setView("page")}>
            Page
          </button>
          {card.shaping === "working" && (
            <span className="muted small">
              <span className="spinner" /> Drawing the page's shapes…
            </span>
          )}
          {card.shaping === "failed" && <span className="fail small">Couldn't draw its shapes; "Read again" tries once more.</span>}
        </div>
      )}
      {card.origin && card.stage === "done" && !showShapes && (
        <SourceView card={card} onReread={props.onRetry} onShowPiece={(key) => (setView("shapes"), setFlash(key))} />
      )}
      {card.object && <ObjectView card={card} onAddPaper={props.onAddPaper} />}
      {showShapes && card.sem && (
        <SemShapes
          title={card.subject ?? "Explanation"}
          sem={card.sem}
          render={(t) => withRegister(t, card.sem!, sources)}
          onTitlePointerDown={props.onGrab}
          labels={pageCard ? { here: "Where the page goes" } : undefined}
          extra={pageCard ? (key) => <FromPage card={card} anchorKey={key} onOpenPage={() => setView("page")} /> : undefined}
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

      <div ref={chatRef}>
        <ChatBox card={card} sources={sources} onAsk={props.onAsk} onFocus={props.onFocus} />
      </div>
      </>
      )}

      {(["left", "right", "top", "bottom"] as const).map((side) => (
        <div
          key={side}
          className={`port port-${side}`}
          title="Drag to another card to ask how the two are related"
          onPointerDown={(e) => props.onPortDown(side, e)}
        />
      ))}

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
      <span className="register-label">{r.label}</span> “{withMath(note.text)}” is {r.gloss}
      {note.field ? `, borrowed from ${note.field}` : ""}.
      {note.means && (
        <div className="register-means">
          {loose ? "What's meant: " : ""}
          {withMath(note.means)}
        </div>
      )}
    </div>
  );
}

/** For a box on a page: which of its words are strict terms and which are informal (principle 9). */
function TermsList({ terms }: { terms: RegisterNote[] }) {
  return (
    <div className="terms-list">
      <span className="terms-title">In your selection</span>
      {terms.map((t, i) => (
        <span
          key={i}
          className={`term-chip reg-${t.register}`}
          title={`${REGISTERS[t.register].label}: ${REGISTERS[t.register].gloss}${t.field ? `, borrowed from ${t.field}` : ""}.${t.means ? ` ${t.means}` : ""}`}
        >
          <span className="term-text">{transcription(t.text)}</span>
          <span className="term-reg">{REGISTERS[t.register].label.toLowerCase()}</span>
          {t.means && (t.register === "casual" || t.register === "notation") && <span className="term-means">= {withMath(t.means)}</span>}
        </span>
      ))}
    </div>
  );
}

/** A conversation held at this card: everything said stays here, on the canvas. */
function ChatBox({
  card,
  sources,
  onAsk,
  onFocus,
}: {
  card: CardItem;
  sources: FoundSource[];
  onAsk: (text: string) => void;
  onFocus: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const messages = card.chat ?? [];
  const send = () => {
    const text = draft.trim();
    if (!text || card.chatPending) return;
    onAsk(text);
    setDraft("");
  };
  return (
    <div className="chat">
      {messages.map((m, i) => (
        <div key={i} className={`chat-msg chat-${m.role}`}>
          <span className="chat-who">{m.role === "user" ? "You" : "Librarian"}</span>
          {m.objectId ? (
            // What the conversation made lives on its own card; this line just points to it.
            <button type="button" className="chat-object" onClick={() => onFocus(m.objectId!)}>
              {m.text} →
            </button>
          ) : (
            <p className="chat-text">{m.role === "assistant" ? withCitations(m.text, sources) : m.text}</p>
          )}
        </div>
      ))}
      {card.chatPending && (
        <p className="muted card-stage">
          <span className="spinner" /> Thinking about it…
        </p>
      )}
      <textarea
        className="chat-input"
        rows={1}
        value={draft}
        placeholder={messages.length ? "Ask a follow-up, or ask for videos, reading, a diagram…" : "Ask about this, or ask for videos, reading, a diagram…"}
        disabled={card.chatPending}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter starts a new line.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

/** An object a conversation made: videos to watch, pages to read, or a diagram. */
function ObjectView({ card, onAddPaper }: { card: CardItem; onAddPaper: (paper: Paper) => Promise<void> }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const o = card.object!;
  if (o.type === "diagram")
    return (
      <figure className="object-diagram">
        {/* Shown as an image: the browser runs nothing inside it. */}
        <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.svg)}`} alt={card.subject ?? "Diagram"} draggable={false} />
        {o.caption && <figcaption className="facet-text">{o.caption}</figcaption>}
      </figure>
    );
  if (o.type === "videos")
    return (
      <div className="object-videos">
        {o.videos.map((v) =>
          playing === v.videoId ? (
            <div key={v.videoId} className="video playing">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${v.videoId}?autoplay=1`}
                title={v.title}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
              />
              <a href={v.url} target="_blank" rel="noreferrer" className="small">
                {v.title}
              </a>
            </div>
          ) : (
            <button key={v.videoId} type="button" className="video" onClick={() => setPlaying(v.videoId)} title="Play here">
              <img src={`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`} alt="" loading="lazy" draggable={false} />
              <span className="video-title">{v.title}</span>
            </button>
          ),
        )}
      </div>
    );
  if (o.type === "papers")
    return (
      <ol className="paper-list">
        {o.papers.map((p) => (
          <PaperRow key={p.id} paper={p} onAdd={(paper) => onAddPaper(paper)} />
        ))}
      </ol>
    );
  return (
    <ol className="object-links">
      {o.links.map((l) => (
        <li key={l.n}>
          <a href={l.url} target="_blank" rel="noreferrer">
            {l.title || domain(l.url)}
          </a>{" "}
          <span className="muted small">{domain(l.url)}</span>
          {l.snippet && <p className="small">{l.snippet.slice(0, 180)}…</p>}
        </li>
      ))}
    </ol>
  );
}

/** Under a piece of a page's shapes: the page's own words it came from, opened on demand. */
function FromPage({ card, anchorKey, onOpenPage }: { card: CardItem; anchorKey: string; onOpenPage: () => void }) {
  const [open, setOpen] = useState(false);
  const ns = card.anchors?.[anchorKey];
  if (!ns?.length) return null;
  const paras = paragraphs(card.pageText ?? "");
  return (
    <span className="from-page">
      <button
        type="button"
        className="from-toggle"
        title={open ? "Hide the page's words" : "Show the page's own words for this"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setOpen(!open)}
      >
        ¶
      </button>
      {open && (
        <span className="from-quote">
          {ns.map((n) => (
            <span key={n} className="source-para from-para">
              {withMath((paras[n] ?? "").replace(/^## /, ""))}
            </span>
          ))}
          <button type="button" className="link small" onPointerDown={(e) => e.stopPropagation()} onClick={onOpenPage}>
            Read it in the page
          </button>
        </span>
      )}
    </span>
  );
}

/** The text of one piece of a Sem, by its key. */
function pieceText(sem: Sem, key: string): string {
  const [kind, n] = key.split("-");
  const i = Number(n);
  if (kind === "why") return sem.why[i] ?? "";
  if (kind === "here") return sem.here[i] ?? "";
  if (kind === "what") return [sem.what.gist, ...sem.what.details].filter(Boolean)[i] ?? "";
  if (kind === "part") return sem.parts[i] ? `${sem.parts[i].symbol}: ${sem.parts[i].meaning}` : "";
  if (kind === "together") return sem.together;
  return "";
}

/** The librarian's question before explaining: likely answers to click, your own words, or skip. */
function AskView({ clarify, onAnswer }: { clarify: Clarify; onAnswer: (answer: string) => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const send = (a: string) => {
    if (sent) return;
    setSent(true);
    onAnswer(a);
  };
  return (
    <div className="ask" onPointerDown={(e) => e.stopPropagation()}>
      <p className="ask-question">{withMath(clarify.question)}</p>
      <div className="ask-options">
        {clarify.options.map((o) => (
          <button key={o} type="button" className="secondary" disabled={sent} onClick={() => send(o)}>
            {o}
          </button>
        ))}
      </div>
      <form
        className="row ask-own"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send(text.trim());
        }}
      >
        <input value={text} disabled={sent} placeholder="Or say it in your own words…" onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={sent || !text.trim()}>
          Answer
        </button>
      </form>
      <button type="button" className="link small" disabled={sent} onClick={() => send("")}>
        Skip, just explain
      </button>
    </div>
  );
}

/** A transcription is LaTeX when it's math; otherwise words that may hold some. */
function transcription(t: string): ReactNode {
  // Delimited formulas render in place among the words; bare LaTeX is one formula.
  return /\\[(\[]|\$/.test(t) || !looksLikeTex(t) ? withMath(t) : <Tex tex={t} display />;
}

/** A starting point that isn't an image: a page someone linked to, or a statement they typed. */
function SourceView({ card, onReread, onShowPiece }: { card: CardItem; onReread: () => void; onShowPiece: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const o = card.origin!;
  if (o.kind === "note") return <p className="source-para source-note">{withMath(o.title)}</p>;
  // Paragraphs, "## " headings, images as ![alt](url), and formulas between \( \) or \[ \].
  const paras = paragraphs(card.pageText ?? "");
  // Each paragraph a piece of the shapes came from links back to that piece.
  const pieceOf = new Map<number, string>();
  for (const [key, ns] of Object.entries(card.anchors ?? {})) for (const n of ns) if (!pieceOf.has(n)) pieceOf.set(n, key);
  const LIMIT = 6000;
  let used = 0;
  const shown = all ? paras : paras.filter((p) => (used += p.length) <= LIMIT || used === p.length);
  return (
    <div className="source-page">
      <a href={o.url} target="_blank" rel="noreferrer" className="small source-link">
        {o.site ?? domain(o.url)} ↗
      </a>{" "}
      <button type="button" className="link small" title="Fetch the page again" onClick={onReread}>
        Read again
      </button>
      {shown.map((para, i) => {
        const img = para.match(/^!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)$/);
        if (img) {
          return (
            <figure key={i} className="source-figure">
              <img src={img[2]} alt={img[1]} loading="lazy" referrerPolicy="no-referrer" draggable={false} />
            </figure>
          );
        }
        if (para.startsWith("## ")) return <p key={i} className="source-para source-heading">{withMath(para.slice(3))}</p>;
        const key = pieceOf.get(i);
        return (
          <p key={i} className={`source-para ${key ? "anchored" : ""}`}>
            {key && card.sem && (
              <button
                type="button"
                className="to-shape"
                title={`In the shapes: ${pieceText(card.sem, key)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onShowPiece(key)}
              >
                ◆
              </button>
            )}
            {withMath(para)}
          </p>
        );
      })}
      {shown.length < paras.length && (
        <button type="button" className="link small" onClick={() => setAll(true)}>
          Show the whole page
        </button>
      )}
    </div>
  );
}
