// Someone's own work, looked at with them: what they're doing, the established ideas it uses or
// reaches for (named, with where they come from and where this version differs from the usual
// one), and where to go next. Each idea can become a card of its own: an explanation, papers,
// videos. Hovering an idea marks the lines it's in.
import { useState } from "react";
import type { WorkLook } from "../shared/canvas.ts";
import { Tex, withMath } from "./MathText.tsx";

export function WorkView({
  work,
  done,
  onExplain,
  onAsk,
}: {
  work: WorkLook;
  done: boolean;
  /** A card explaining this idea, hung from this one. */
  onExplain: (name: string, context: string, clientY: number) => void;
  /** Asks this card's librarian for something (papers, videos) about it. */
  onAsk: (text: string) => void;
}) {
  const [lit, setLit] = useState<number[]>([]);
  // Lines are only shown once there's something said about them; while reading, they arrive as read.
  return (
    <div className="work" onPointerDown={(e) => (e.target as HTMLElement).closest("button") && e.stopPropagation()}>
      {work.opening && <p className="work-opening">{withMath(work.opening)}</p>}
      <ol className="work-lines">
        {work.lines.map((l, i) => (
          <li key={i} className={lit.includes(i + 1) ? "lit" : ""}>
            <span className="work-n">{i + 1}</span>
            <span className="work-line">{l.latex ? <Tex tex={l.latex} display={false} /> : <code>{l.sympy}</code>}</span>
          </li>
        ))}
      </ol>
      {work.ideas.map((idea, k) => (
        <section key={k} className={`work-idea ${idea.differs ? "differs" : ""}`} onMouseEnter={() => setLit(idea.lines)} onMouseLeave={() => setLit([])}>
          <h4>
            {idea.name}
            {idea.lines.length > 0 && (
              <span className="work-at muted small">
                {" "}
                · {idea.lines.length === 1 ? `line ${idea.lines[0]}` : `lines ${Math.min(...idea.lines)}–${Math.max(...idea.lines)}`}
              </span>
            )}
          </h4>
          {idea.what && <p className="work-what">{withMath(idea.what)}</p>}
          {idea.origin && <p className="muted small work-origin">{idea.origin}</p>}
          {idea.note && <p className="work-note">{withMath(idea.note)}</p>}
          {done && (
            <div className="work-go">
              <button type="button" className="secondary" onClick={(e) => onExplain(idea.name, `${idea.what} (seen in their own work: ${idea.note})`, e.clientY)}>
                Explain it
              </button>
              <button type="button" className="secondary" onClick={() => onAsk(`Find papers on ${idea.name}`)}>
                Papers
              </button>
              <button type="button" className="secondary" onClick={() => onAsk(`Find videos on ${idea.name}`)}>
                Videos
              </button>
            </div>
          )}
        </section>
      ))}
      {work.invite && <p className="work-invite">{withMath(work.invite)}</p>}
    </div>
  );
}
