// Someone's own working, checked: each line as they wrote it, marked by what SymPy found (follows,
// doesn't, couldn't tell), the first wrong line picked out, and what went wrong there. The hint
// waits to be asked for, so they can try first.
import { useState } from "react";
import type { WorkCheck, WorkStep } from "../shared/canvas.ts";
import { Tex, withMath } from "./MathText.tsx";

const MARK: Record<WorkStep["status"], { sign: string; title: string }> = {
  given: { sign: "", title: "Where it starts" },
  ok: { sign: "✓", title: "Follows from the line before (checked with SymPy)" },
  wrong: { sign: "✗", title: "Doesn't follow from the line before (checked with SymPy)" },
  unchecked: { sign: "?", title: "Couldn't be checked" },
};

export function WorkView({ work, done }: { work: WorkCheck; done: boolean }) {
  const [hint, setHint] = useState(false);
  const checked = work.steps.some((s) => s.status !== "unchecked") || done;
  return (
    <div className="work">
      <ol className="work-steps">
        {work.steps.map((s, i) => {
          const after = work.wrongAt !== undefined && i > work.wrongAt;
          const m = MARK[s.status];
          return (
            <li key={i} className={`work-step ${checked ? s.status : "reading"} ${i === work.wrongAt ? "first-wrong" : ""} ${after ? "after-wrong" : ""}`}>
              <span className="work-n">{i + 1}</span>
              <span className="work-line">{s.latex ? <Tex tex={s.latex} display={false} /> : <code>{s.sympy}</code>}</span>
              {checked && (
                <span className="work-mark" title={s.note ? `${m.title}: ${s.note}` : m.title}>
                  {m.sign}
                </span>
              )}
              {checked && s.note && s.status !== "given" && <span className="work-note">{s.note}</span>}
            </li>
          );
        })}
      </ol>
      {work.verdict && <p className="work-verdict">{withMath(work.verdict)}</p>}
      {work.why && (
        <section className="work-why">
          <h4>What went wrong on line {(work.wrongAt ?? 0) + 1}</h4>
          <p>{withMath(work.why)}</p>
        </section>
      )}
      {work.hint &&
        (hint ? (
          <section className="work-hint">
            <h4>A hint</h4>
            <p>{withMath(work.hint)}</p>
          </section>
        ) : (
          <button type="button" className="secondary work-hint-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => setHint(true)}>
            Show a hint
          </button>
        ))}
      {done && <p className="muted small work-how">✓ and ✗ are checked with a computer algebra system (SymPy), not guessed. A ? is a line it couldn't check.</p>}
    </div>
  );
}
