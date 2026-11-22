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
}: {
  title: string;
  sem: Sem;
  render: Render;
  /** Anything to show under a piece, by its key ("why-0", "what-0", "part-1", "together", "here-2"). */
  extra?: (key: string) => ReactNode;
  /** Section headings to use instead of the usual ones. */
  labels?: Partial<Record<Section["key"], string>>;
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
  }, [sem]);

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
            <div className="sem-cat" data-a={`cat-${s.key}`}>
              {labels?.[s.key] ?? s.label}
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
              {s.key === "parts" && (
                <>
                  <div className="sem-parts">
                    {sem.parts.map((p, i) => (
                      <div key={i} className="sem-part" data-a={`part-${i}`}>
                        {/\\[(\[]/.test(p.symbol) ? withMath(p.symbol) : looksLikeTex(p.symbol) ? <Tex tex={p.symbol} /> : <code>{p.symbol}</code>}
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
                </>
              )}
            </div>
          </div>
        ))}
        {sem.name && (
          <div className="sem-aside" data-a="aside">
            <span className="sem-aside-label">The name</span> {render(sem.name)}
          </div>
        )}
      </div>
    </div>
  );
}
