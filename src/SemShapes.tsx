// Draws a Sem (an explanation's structure) with the semshape vocabulary.
// Text is ordinary HTML in normal flow, so it wraps and stays selectable for descent;
// an SVG layer then draws the shapes between the measured text blocks.
import { looksLikeTex, Tex, withMath } from "./MathText.tsx";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import type { Sem } from "../shared/canvas.ts";

type Render = (text: string) => ReactNode;

interface Section {
  key: "why" | "what" | "parts" | "here";
  label: string;
}

const SECTIONS: Section[] = [
  { key: "why", label: "Why it exists" },
  { key: "what", label: "What it is" },
  { key: "parts", label: "Its parts" },
  { key: "here", label: "How it's used here" },
];

const LINE_MID = 10; // half the text line height: where an arrow meets the first line
// Arrowhead length. Lines stop where the head begins and the head carries on to the target, so
// a line never runs under the head and pokes out at its point.
const ARROW = 8;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Drawn {
  thick: string[]; // category-level bus and arrows
  thin: string[]; // description-level lines with arrowheads
  plain: string[]; // lines without arrowheads (bus segments)
  story: string[]; // filled story-arrow polygons
}

export function SemShapes({
  title,
  sem,
  render,
  onTitlePointerDown,
  extra,
  labels,
  head,
  belowParts,
  layout,
  sides,
}: {
  title: string;
  sem: Sem;
  render: Render;
  /** Anything to show under a piece, by its key ("why-0", "what-0", "part-1", "together", "here-2"). */
  extra?: (key: string) => ReactNode;
  /** Section headings to use instead of the usual ones. */
  labels?: Partial<Record<Section["key"], string>>;
  /** Anything to show beside a section's heading, by its key ("cat-why", …). */
  head?: (key: string) => ReactNode;
  /**
   * Anything grown from a part, drawn at full width under the row of parts rather than squeezed
   * into its narrow box, with the part's name.
   */
  belowParts?: (key: string, name: string) => ReactNode;
  /**
   * How the parts are shaped, for a relation card. "compare": what both share forks into two
   * columns, a row for each point (meaning is the first's side, note the second's). "sequence": the
   * two in order, a story arrow from the one to the other carrying `together`. "within": the whole,
   * with the part hanging off it by the description bend. None: a bus into each part and a Y-connector.
   */
  layout?: "compare" | "sequence" | "within";
  /** For "compare": the names heading the two columns. */
  sides?: string[];
  /** The title doubles as the card's move handle. */
  onTitlePointerDown?: (e: React.PointerEvent) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<Drawn>({ thick: [], thin: [], plain: [], story: [] });
  const marker = `sem-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const present = SECTIONS.filter((s) =>
    s.key === "why" ? sem.why.length : s.key === "what" ? sem.what.gist : s.key === "parts" ? sem.parts.length : sem.here.length,
  );

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const c = el.getBoundingClientRect();
      const scale = c.width / el.offsetWidth || 1;
      const box = (a: string): Box | null => {
        const n = el.querySelector<HTMLElement>(`[data-a="${a}"]`);
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return { x: (r.left - c.left) / scale, y: (r.top - c.top) / scale, w: r.width / scale, h: r.height / scale };
      };
      const all = (prefix: string) =>
        Array.from(el.querySelectorAll<HTMLElement>(`[data-a^="${prefix}"]`)).map((n) => box(n.dataset.a!)!);

      const d: Drawn = { thick: [], thin: [], plain: [], story: [] };
      const title = box("title");
      const cats = present.map((s) => box(`cat-${s.key}`)).filter((b): b is Box => !!b);
      const aside = box("aside");

      // Title to categories: begins under the title, bends down and left, then a bus with an arrow to each.
      if (title && cats.length) {
        const busX = 10;
        const top = title.y + title.h;
        const last = aside ? aside.y + LINE_MID : cats[cats.length - 1].y + cats[cats.length - 1].h / 2;
        d.plain.push(`M${busX + 14} ${top} L${busX} ${top + 14} V${last}`);
        for (const cat of cats) d.thick.push(`M${busX} ${cat.y + cat.h / 2} H${Math.max(busX + 6, cat.x - 2 - ARROW)}`);
        if (aside) {
          const y = aside.y + LINE_MID;
          const end = Math.max(busX + 8, aside.x - 2 - ARROW);
          d.thin.push(`M${busX} ${y - 8} Q${busX} ${y} ${Math.min(busX + 6, end - 2)} ${y} H${end}`);
        }
      }

      for (const s of present) {
        const cat = box(`cat-${s.key}`);
        if (!cat) continue;
        if (s.key === "why" || s.key === "here") {
          // Path: a story arrow into the first step, then a bended arrow from each step to the next.
          const steps = all(`${s.key}-`);
          if (!steps.length) continue;
          const first = steps[0];
          const sx = cat.x + 22;
          const y0 = cat.y + cat.h + 2;
          const y1 = first.y - 2;
          if (y1 - y0 > 6) {
            const neck = Math.max(y0 + 2, y1 - 9);
            d.story.push(`${sx - 5},${y0} ${sx + 5},${y0} ${sx + 5},${neck} ${sx + 10},${neck} ${sx},${y1} ${sx - 10},${neck} ${sx - 5},${neck}`);
          }
          for (let i = 1; i < steps.length; i++) {
            const a = steps[i - 1];
            const b = steps[i];
            const y2 = b.y + LINE_MID;
            const end = b.x - 3 - ARROW;
            // The curve must arrive travelling right, so it starts left of where it ends; otherwise
            // the head follows a leftward tangent and points backwards.
            const x1 = Math.min(a.x + 14, end - 10);
            d.thin.push(`M${x1} ${a.y + a.h} Q${x1} ${y2} ${end} ${y2}`);
          }
        } else if (s.key === "what") {
          // Category with Descriptions: the description bend, a thinner bus, an arrow to each line.
          const descs = all("what-");
          if (!descs.length) continue;
          const busX = cat.x + 10;
          const top = cat.y + cat.h;
          d.plain.push(`M${busX + 12} ${top} L${busX} ${top + 12} V${descs[descs.length - 1].y + LINE_MID}`);
          for (const t of descs) d.thin.push(`M${busX} ${t.y + LINE_MID} H${Math.max(busX + 6, t.x - 3 - ARROW)}`);
        } else if (s.key === "parts" && layout === "compare") {
          // Bifurcation: the category into what both share, which forks into the two columns; each
          // column is a category with descriptions, a bus down its side and an arrow to each cell.
          const shared = box("together");
          const heads = [box("col-0"), box("col-1")].filter((b): b is Box => !!b);
          const sx = cat.x + 22;
          if (shared) d.thin.push(`M${sx} ${cat.y + cat.h} V${shared.y + LINE_MID} H${shared.x - 3 - ARROW}`);
          const from = shared ? { x: shared.x + 40, y: shared.y + shared.h } : { x: sx, y: cat.y + cat.h };
          for (const [i, h] of heads.entries()) {
            const tx = h.x + 14;
            const ty = h.y - 2 - ARROW;
            const fy = (from.y + ty) / 2;
            d.thick.push(`M${from.x} ${from.y} V${fy - 8} L${from.x + Math.sign(tx - from.x) * 8} ${fy} H${tx - Math.sign(tx - from.x) * 8} L${tx} ${fy + 8} V${ty}`);
            const cells = all(`cmp-`).filter((_, k) => k % 2 === i);
            if (!cells.length) continue;
            const bx = h.x + 4;
            d.plain.push(`M${bx} ${h.y + h.h} V${cells[cells.length - 1].y + LINE_MID}`);
            for (const c of cells) d.thin.push(`M${bx} ${c.y + LINE_MID} H${Math.max(bx + 6, c.x - 3 - ARROW)}`);
          }
        } else if (s.key === "parts" && layout === "sequence") {
          // Path: the category's line into the first, which leads on to the second (the story arrow, drawn in place).
          const first = box("part-0");
          if (first) d.thin.push(`M${cat.x + 22} ${cat.y + cat.h} V${first.y - 2 - ARROW}`);
        } else if (s.key === "parts" && layout === "within") {
          // The whole, and the part hanging off it by the description bend.
          const whole = box("part-0");
          const part = box("part-1");
          if (whole) d.thick.push(`M${cat.x + 22} ${cat.y + cat.h} V${whole.y - 2 - ARROW}`);
          if (whole && part) {
            const bx = whole.x + 20;
            d.plain.push(`M${bx + 12} ${whole.y + whole.h} L${bx} ${whole.y + whole.h + 12} V${part.y + LINE_MID}`);
            d.thin.push(`M${bx} ${part.y + LINE_MID} H${part.x - 3 - ARROW}`);
          }
          const join = box("together");
          if (join && part) d.thin.push(`M${part.x + 14} ${part.y + part.h} V${join.y - 2 - ARROW}`);
        } else if (s.key === "parts") {
          // Horizontal category bus down into each part, then a Y-connector to what they add up to.
          const parts = all("part-");
          if (!parts.length) continue;
          const busY = parts[0].y - 12;
          const centers = parts.map((p) => p.x + p.w / 2);
          d.plain.push(`M${cat.x + 22} ${cat.y + cat.h} V${busY}`);
          d.plain.push(`M${Math.min(cat.x + 22, ...centers)} ${busY} H${Math.max(...centers)}`);
          for (const p of parts) d.thin.push(`M${p.x + p.w / 2} ${busY} V${p.y - 2 - ARROW}`);
          const join = box("together");
          if (join) {
            const jx = join.x + join.w / 2;
            const jy = join.y - 14;
            for (const p of parts) d.plain.push(`M${p.x + p.w / 2} ${p.y + p.h} L${jx} ${jy}`);
            d.thin.push(`M${jx} ${jy} V${join.y - 2 - ARROW}`);
          }
        }
      }
      setDrawn(d);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // `present` is derived from `sem`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sem, layout]);

  return (
    <div className="sem" ref={root}>
      <svg className="sem-lines" aria-hidden>
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="0" refY="5" markerUnits="userSpaceOnUse" markerWidth={ARROW} markerHeight={ARROW} orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="sem-head" />
          </marker>
        </defs>
        {drawn.plain.map((p, i) => (
          <path key={`p${i}`} d={p} className="sem-bus" />
        ))}
        {drawn.thick.map((p, i) => (
          <path key={`k${i}`} d={p} className="sem-bus thick" markerEnd={`url(#${marker})`} />
        ))}
        {drawn.thin.map((p, i) => (
          <path key={`t${i}`} d={p} className="sem-edge" markerEnd={`url(#${marker})`} />
        ))}
        {drawn.story.map((p, i) => (
          <polygon key={`s${i}`} points={p} className="sem-story" />
        ))}
      </svg>

      <div className="sem-title" data-a="title" title="Drag to move this card" onPointerDown={onTitlePointerDown}>
        {title}
      </div>
      <div className="sem-body">
        {present.map((s) => (
          <div key={s.key} className={`sem-section facet-${s.key}`}>
            <div className="sem-cat-row">
              <div className="sem-cat" data-a={`cat-${s.key}`}>
                {labels?.[s.key] ?? s.label}
              </div>
              {head?.(`cat-${s.key}`)}
            </div>
            <div className="sem-kids">
              {(s.key === "why" || s.key === "here") &&
                sem[s.key].map((step, i) => (
                  <div key={i} className="sem-step" data-a={`${s.key}-${i}`} style={{ marginLeft: Math.min(i, 3) * 22 }}>
                    {render(step)}
                    {extra?.(`${s.key}-${i}`)}
                  </div>
                ))}
              {s.key === "what" &&
                [sem.what.gist, ...sem.what.details].filter(Boolean).map((t, i) => (
                  <div key={i} className={`sem-desc ${i === 0 ? "gist" : ""}`} data-a={`what-${i}`}>
                    {render(t)}
                    {extra?.(`what-${i}`)}
                  </div>
                ))}
              {s.key === "parts" && layout === "compare" && (
                <>
                  {sem.together && (
                    <div className="sem-together sem-shared" data-a="together">
                      {render(sem.together)}
                      {extra?.("together")}
                    </div>
                  )}
                  <div className="sem-compare">
                    <div className="sem-compare-aspect" />
                    {[0, 1].map((i) => (
                      <div key={i} className="sem-compare-head" data-a={`col-${i}`}>
                        {sides?.[i] ?? (i ? "Second" : "First")}
                      </div>
                    ))}
                    {sem.parts.map((p, i) => (
                      <div key={i} className="sem-compare-row" data-a={`part-${i}`}>
                        <div className="sem-compare-aspect">
                          <code>{p.symbol}</code>
                          {extra?.(`part-${i}`)}
                        </div>
                        <div className="sem-compare-cell" data-a={`cmp-${i}-0`}>
                          {render(p.meaning)}
                        </div>
                        <div className="sem-compare-cell" data-a={`cmp-${i}-1`}>
                          {render(p.note)}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {s.key === "parts" && layout === "sequence" && (
                <>
                  <div className="sem-sequence">
                    {sem.parts.slice(0, 2).map((p, i) => (
                      <div key={i} className="sem-part" data-a={`part-${i}`} style={{ gridColumn: i ? 3 : 1 }}>
                        <code>{p.symbol}</code>
                        <div className="sem-part-meaning">{render(p.meaning)}</div>
                        {p.note && <div className="sem-part-note">{render(p.note)}</div>}
                        {extra?.(`part-${i}`)}
                      </div>
                    ))}
                    <div className="sem-sequence-arrow" style={{ gridColumn: 2, gridRow: 1 }}>
                      <svg viewBox="0 0 40 24" preserveAspectRatio="none" aria-hidden>
                        <polygon points="0,7 26,7 26,0 40,12 26,24 26,17 0,17" className="sem-story" />
                      </svg>
                    </div>
                  </div>
                  {sem.together && (
                    <div className="sem-together sem-via" data-a="together">
                      {render(sem.together)}
                      {extra?.("together")}
                    </div>
                  )}
                </>
              )}
              {s.key === "parts" && layout === "within" && (
                <>
                  {sem.parts.slice(0, 2).map((p, i) => (
                    <div key={i} className={`sem-part ${i ? "sem-within-part" : "sem-within-whole"}`} data-a={`part-${i}`}>
                      <code>{p.symbol}</code>
                      <div className="sem-part-meaning">{render(p.meaning)}</div>
                      {p.note && <div className="sem-part-note">{render(p.note)}</div>}
                      {extra?.(`part-${i}`)}
                    </div>
                  ))}
                  {sem.together && (
                    <div className="sem-together" data-a="together">
                      {render(sem.together)}
                      {extra?.("together")}
                    </div>
                  )}
                </>
              )}
              {s.key === "parts" && !layout && (
                <>
                  <div className="sem-parts">
                    {sem.parts.map((p, i) => (
                      <div key={i} className="sem-part" data-a={`part-${i}`}>
                        {/\\[(\[]|\$/.test(p.symbol) ? withMath(p.symbol) : looksLikeTex(p.symbol) ? <Tex tex={p.symbol} /> : <code>{p.symbol}</code>}
                        <div className="sem-part-meaning">{render(p.meaning)}</div>
                        {p.note && <div className="sem-part-note">{render(p.note)}</div>}
                        {extra?.(`part-${i}`)}
                      </div>
                    ))}
                  </div>
                  {sem.together && (
                    <div className="sem-together" data-a="together">
                      {render(sem.together)}
                      {extra?.("together")}
                    </div>
                  )}
                  {/* After what they add up to, so the Y-connector into it stays clear. */}
                  {sem.parts.map((p, i) => (
                    <div key={i}>{belowParts?.(`part-${i}`, p.meaning || p.symbol)}</div>
                  ))}
                </>
              )}
              {extra?.(`cat-${s.key}`)}
            </div>
          </div>
        ))}
        {sem.name && (
          <div className="sem-aside" data-a="aside">
            <span className="sem-aside-label">The name</span> {render(sem.name)}
            {extra?.("aside")}
          </div>
        )}
      </div>
    </div>
  );
}
