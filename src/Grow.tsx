// Growing an explanation's diagram from any piece of it: pick a shape from the VizShapes
// vocabulary (or say what you want and the librarian picks), and it grows right there. Each piece
// of what grows can grow in turn.
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Extension, ExtensionShape } from "../shared/canvas.ts";

type Render = (text: string) => ReactNode;

export type GrowRequest = { at: string; shape?: ExtensionShape; ask?: string; focus?: string };

const SHAPES: { shape: ExtensionShape; label: string; hint: string; icon: ReactNode }[] = [
  { shape: "aside", label: "Say more", hint: "An aside: a few lines off to the side about this", icon: <AsideIcon /> },
  { shape: "why", label: "Why?", hint: "A path of reasons that ends here: since… so…", icon: <PathIcon /> },
  { shape: "then", label: "Then what?", hint: "A path of what follows from this", icon: <PathIcon down /> },
  { shape: "steps", label: "Steps", hint: "How it's done, as numbered steps", icon: <StepsIcon /> },
  { shape: "parts", label: "Break it down", hint: "The parts it's made of, and what they add up to", icon: <PartsIcon /> },
  { shape: "split", label: "Two ways", hint: "Two ways, two cases, or two sides of it", icon: <SplitIcon /> },
  { shape: "example", label: "For example", hint: "One concrete example, worked through", icon: <ExampleIcon /> },
];

/** The + on a piece: opens the palette of shapes to grow from it. */
export function GrowButton({ at, onGrow, title = "Grow more from this" }: { at: string; onGrow: (r: GrowRequest) => void; title?: string }) {
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState("");
  const [focus, setFocus] = useState("");
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const grow = (r: Omit<GrowRequest, "at">) => {
    onGrow({ at, ...r, ...(focus ? { focus } : {}) });
    setOpen(false);
    setAsk("");
  };

  return (
    <span className={`grow ${open ? "open" : ""}`} ref={box} onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="grow-btn"
        title={title}
        // Keep a selection inside the piece: those words become what to grow about.
        onMouseDown={(e) => {
          e.preventDefault();
          const sel = window.getSelection();
          const piece = box.current?.parentElement;
          const text = sel && !sel.isCollapsed && piece?.contains(sel.anchorNode) ? sel.toString().replace(/\s+/g, " ").trim() : "";
          setFocus(text.slice(0, 200));
        }}
        onClick={() => setOpen(!open)}
      >
        +
      </button>
      {open && (
        <span className="grow-menu" role="menu">
          {focus && (
            <span className="grow-focus">
              About <span className="grow-circle">{focus.length > 40 ? `${focus.slice(0, 40)}…` : focus}</span>
            </span>
          )}
          <span className="grow-shapes">
            {SHAPES.map((s) => (
              <button key={s.shape} type="button" role="menuitem" title={s.hint} onClick={() => grow({ shape: s.shape })}>
                {s.icon}
                {s.label}
              </button>
            ))}
          </span>
          <form
            className="grow-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (ask.trim()) grow({ ask: ask.trim() });
            }}
          >
            <input autoFocus value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Or say what you want here…" />
          </form>
        </span>
      )}
    </span>
  );
}

/** Everything grown at one piece, drawn in its shape, each piece growable in turn. */
export function Grown({
  ext,
  at,
  from,
  render,
  onGrow,
  onRemove,
  onShow,
}: {
  ext: Extension[];
  at: string;
  /** When drawn away from its piece (under a row of parts): the piece's name, to say where it grew from. */
  from?: string;
  render: Render;
  onGrow: (r: GrowRequest) => void;
  onRemove: (id: string) => void;
  /** Goes to a card made for an ask (the videos it found). */
  onShow?: (cardId: string) => void;
}) {
  const here = ext.filter((e) => e.at === at);
  if (!here.length) return null;
  // A piece of a grown shape: its text, its +, and whatever has grown from it (unless that is
  // drawn elsewhere, as for narrow boxes in a row).
  const piece = (key: string, text: string, className = "", grownHere = true) => (
    <div className={`grown-piece ${className}`} data-x={key}>
      {render(text)}
      <GrowButton at={key} onGrow={onGrow} />
      {grownHere && <Grown ext={ext} at={key} render={render} onGrow={onGrow} onRemove={onRemove} onShow={onShow} />}
    </div>
  );
  const below = (key: string, name: string) => <Grown ext={ext} at={key} from={name} render={render} onGrow={onGrow} onRemove={onRemove} onShow={onShow} />;
  return (
    <>
      {here.map((e) => (
        <div key={e.id} className={`grown grown-shape-${e.shape} ${e.status}`}>
          <button type="button" className="grown-remove" title="Take this away" onClick={() => onRemove(e.id)}>
            ×
          </button>
          {e.focus && (
            <div className="grown-about">
              About <span className="grow-circle">{e.focus}</span>
            </div>
          )}
          {from && (
            <div className="grown-from">
              From <span className="grow-circle">{from}</span>
            </div>
          )}
          {e.ask && <div className="grown-ask">“{e.ask}”</div>}
          {e.status === "working" ? (
            <div className="grown-working">
              <span className="spinner" /> {e.ask ? "Working out how best to answer…" : `Growing ${SHAPES.find((s) => s.shape === e.shape)?.label.toLowerCase()}…`}
            </div>
          ) : e.status === "failed" ? (
            <div className="grown-failed">
              Couldn't grow this{e.error ? `: ${e.error}` : "."}{" "}
              <button
                type="button"
                className="link"
                onClick={() => {
                  onRemove(e.id);
                  onGrow({ at: e.at, shape: e.shape, ask: e.ask, focus: e.focus });
                }}
              >
                Try again
              </button>
            </div>
          ) : e.made ? (
            // Asked for a thing, not words: it's on its own card, hung from this piece.
            <div className="grown-made">
              <span>{e.items?.[0]}</span>
              {onShow && (
                <button type="button" className="link" onPointerDown={(ev) => ev.stopPropagation()} onClick={() => onShow(e.made!)}>
                  Show ↗
                </button>
              )}
            </div>
          ) : (
            <Shape e={e} piece={piece} below={below} render={render} />
          )}
        </div>
      ))}
    </>
  );
}

/** One block of a restructured page, drawn in its shape; its pieces grow like any other. */
export function ShapeBlock({
  block,
  ext,
  render,
  onGrow,
  onRemove,
  onShow,
  extra,
}: {
  block: Extension;
  ext: Extension[];
  render: Render;
  onGrow: (r: GrowRequest) => void;
  onRemove: (id: string) => void;
  onShow?: (cardId: string) => void;
  /** Shown beside the block's label: where on the page it came from. */
  extra?: ReactNode;
}) {
  const piece = (key: string, text: string, className = "", grownHere = true) => (
    <div className={`grown-piece ${className}`} data-x={key}>
      {render(text)}
      <GrowButton at={key} onGrow={onGrow} />
      {grownHere && <Grown ext={ext} at={key} render={render} onGrow={onGrow} onRemove={onRemove} onShow={onShow} />}
    </div>
  );
  const below = (key: string, name: string) => <Grown ext={ext} at={key} from={name} render={render} onGrow={onGrow} onRemove={onRemove} onShow={onShow} />;
  return (
    <div className={`grown grown-shape-${block.shape} page-block`}>
      {extra}
      <Shape e={block} piece={piece} below={below} render={render} />
    </div>
  );
}

function Shape({
  e,
  piece,
  below,
  render,
}: {
  e: Extension;
  piece: (key: string, text: string, className?: string, grownHere?: boolean) => ReactNode;
  below: (key: string, name: string) => ReactNode;
  render: Render;
}) {
  const k = (rest: string) => `x${e.id}.${rest}`;
  switch (e.shape) {
    case "aside":
    case "example":
      // The aside bend: off to the side of the piece, then down to each line.
      return (
        <div className="grown-aside-col">
          {e.shape === "example" && <div className="grown-label">For example</div>}
          {(e.items ?? []).map((t, i) => (
            <div key={i} className="grown-aside-row">
              <AsideArrow />
              {piece(k(String(i)), t)}
            </div>
          ))}
        </div>
      );
    case "facts":
      // Descriptions: a bus down the side, an arrow to each line.
      return (
        <div className="grown-facts">
          {e.label && <div className="grown-label">{e.label}</div>}
          <div className="grown-facts-col">
            {(e.items ?? []).map((t, i) => (
              <div key={i} className="grown-fact">
                <span className="grown-fact-arrow" aria-hidden />
                {piece(k(String(i)), t)}
              </div>
            ))}
          </div>
        </div>
      );
    case "why":
    case "then":
      // A path: a story arrow into the first step, a bended arrow into each next one.
      return (
        <div className="grown-path">
          <div className="grown-label">{e.label || (e.shape === "why" ? "Why" : "Then")}</div>
          <StoryArrow />
          {(e.items ?? []).map((t, i) => (
            <div key={i} className="grown-path-step" style={{ marginLeft: Math.min(i, 3) * 18 }}>
              {i > 0 && <BendArrow />}
              {piece(k(String(i)), t)}
            </div>
          ))}
        </div>
      );
    case "steps":
      // A procedure: the label, the angular bend, a numeral per step.
      return (
        <div className="grown-steps">
          <div className="grown-label">{e.label || `${e.items?.length ?? 0} steps`}</div>
          {(e.items ?? []).map((t, i) => (
            <div key={i} className="grown-step">
              <span className="grown-numeral">{i + 1}</span>
              {piece(k(String(i)), t)}
            </div>
          ))}
        </div>
      );
    case "parts": {
      const parts = e.parts ?? [];
      // A horizontal category: a bus into each part; a Y-connector into what they add up to.
      return (
        <div className="grown-parts">
          <div className="grown-label">{e.label || `Has ${parts.length} parts`}</div>
          <div className="grown-parts-row" style={{ gridTemplateColumns: `repeat(${parts.length}, 1fr)` }}>
            {parts.map((p, i) => (
              <div key={i} className="grown-part">
                {piece(k(`p${i}`), `${p.name}${p.note ? `: ${p.note}` : ""}`, "", false)}
              </div>
            ))}
          </div>
          {e.together && (
            <>
              <svg className="grown-y" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden>
                {parts.map((_, i) => (
                  <line key={i} x1={((i + 0.5) / parts.length) * 100} y1="0" x2="50" y2="14" />
                ))}
                <line x1="50" y1="14" x2="50" y2="20" />
              </svg>
              {piece(k("t"), e.together, "grown-together")}
            </>
          )}
          {parts.map((p, i) => (
            <div key={i}>{below(k(`p${i}`), p.name)}</div>
          ))}
        </div>
      );
    }
    case "split":
      // A bifurcation: the label, a fork, a column per way.
      return (
        <div className="grown-split">
          <div className="grown-label grown-split-label">{e.label || "Two ways"}</div>
          <ForkArrow />
          <div className="grown-split-row">
            {(e.branches ?? []).map((b, j) => (
              <div key={j} className={`grown-branch ${j === 0 ? "left" : "right"}`}>
                <div className="grown-branch-head" data-x={k(`b${j}`)}>
                  {render(b.label)}
                </div>
                {b.items.map((t, i) => (
                  <div key={i}>{piece(k(`b${j}.${i}`), t)}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      );
  }
}

// ---- The shapes' arrows, drawn small ----

function AsideArrow() {
  return (
    <svg className="grown-arrow aside" viewBox="0 0 24 20" aria-hidden>
      <path d="M2 0 Q2 12 14 12 H18" />
      <path d="M18 8 L23 12 L18 16 z" className="head" />
    </svg>
  );
}

function BendArrow() {
  return (
    <svg className="grown-arrow bend" viewBox="0 0 22 22" aria-hidden>
      <path d="M3 0 Q3 13 15 13" />
      <path d="M14 9 L20 13 L14 17 z" className="head" />
    </svg>
  );
}

function StoryArrow() {
  return (
    <svg className="grown-story" viewBox="0 0 20 14" aria-hidden>
      <path d="M6 0 H14 V6 H19 L10 14 L1 6 H6 z" />
    </svg>
  );
}

function ForkArrow() {
  return (
    <svg className="grown-fork" viewBox="0 0 60 22" aria-hidden>
      <path d="M30 0 V6 Q30 14 18 16" />
      <path d="M30 6 Q30 14 42 16" />
      <path d="M19 12 L12 17 L20 20 z" className="head" />
      <path d="M41 12 L48 17 L40 20 z" className="head" />
    </svg>
  );
}

// ---- The palette's icons ----

function AsideIcon() {
  return (
    <svg className="grow-icon" viewBox="0 0 20 16" aria-hidden>
      <path d="M2 3 H9 M9 3 Q12 3 12 7 V13 M12 13 H18" />
    </svg>
  );
}

function PathIcon({ down = false }: { down?: boolean }) {
  return (
    <svg className="grow-icon" viewBox="0 0 20 16" aria-hidden>
      {down ? <path d="M3 2 Q3 7 8 7 M8 7 Q10 7 10 10 Q10 13 15 13" /> : <path d="M15 2 Q15 7 10 7 Q7 7 7 10 Q7 13 3 13" />}
    </svg>
  );
}

function StepsIcon() {
  return (
    <svg className="grow-icon" viewBox="0 0 20 16" aria-hidden>
      <path d="M4 2 V14 M4 4 H9 M4 9 H9 M4 14 H9 M12 4 H18 M12 9 H18 M12 14 H16" />
    </svg>
  );
}

function PartsIcon() {
  return (
    <svg className="grow-icon" viewBox="0 0 20 16" aria-hidden>
      <path d="M10 1 V4 M3 4 H17 M3 4 V7 M10 4 V7 M17 4 V7 M3 10 L10 14 L17 10" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg className="grow-icon" viewBox="0 0 20 16" aria-hidden>
      <path d="M10 1 V5 Q10 9 4 12 M10 5 Q10 9 16 12" />
    </svg>
  );
}

function ExampleIcon() {
  return (
    <svg className="grow-icon" viewBox="0 0 20 16" aria-hidden>
      <path d="M3 3 H17 V13 H3 z M6 7 H14 M6 10 H11" />
    </svg>
  );
}
