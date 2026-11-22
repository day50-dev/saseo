// Math written as LaTeX between \( \) or \[ \], rendered with KaTeX. Each formula keeps its
// source in data-tex, so selecting it to go further down sends the LaTeX, not the glyphs.
import katex from "katex";
import "katex/dist/katex.min.css";
import type { ReactNode } from "react";

const cache = new Map<string, string | null>();

function render(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: true, output: "html", strict: "ignore", trust: false });
  } catch {
    return null;
  }
}

/** Drops delimiters left over at the ends, like a "\)" with no "\(" (models do this). */
export function stripDelims(tex: string): string {
  return tex
    .trim()
    .replace(/^(\\[([]|\$\$?)\s*/, "")
    .replace(/\s*(\\[)\]]|\$\$?)$/, "")
    .trim();
}

function toHtml(tex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${tex}`;
  if (!cache.has(key)) {
    const bare = stripDelims(tex);
    cache.set(key, render(tex, display) ?? (bare !== tex.trim() ? render(bare, display) : null));
  }
  return cache.get(key)!;
}

/** One formula; if KaTeX can't read it, the LaTeX itself is shown. */
export function Tex({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = toHtml(tex, display);
  if (html === null) return <code className="tex-raw">{tex}</code>;
  return <span className={display ? "math math-display" : "math"} data-tex={stripDelims(tex)} dangerouslySetInnerHTML={{ __html: html }} />;
}

// \( \), \[ \], $$ $$, and single $…$ as models and pages often write it. A single-dollar span
// must hug its contents and not be followed by a digit, so "$5 and $10" stays money.
const MATH = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/g;

/** Whether a single-dollar span is math rather than, say, prices. */
const dollarMath = (t: string) => !/^\d/.test(t) || /\\|[_^]/.test(t);

/** Text with formulas rendered; the plain stretches between them go through `plain`. */
export function withMath(text: string, plain: (s: string) => ReactNode = (s) => s): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MATH)) {
    if (m[4] !== undefined && !dollarMath(m[4])) continue;
    if (m.index > last) out.push(<span key={`t${last}`}>{plain(text.slice(last, m.index))}</span>);
    out.push(<Tex key={`m${m.index}`} tex={(m[1] ?? m[2] ?? m[3] ?? m[4]).trim()} display={m[2] !== undefined || m[3] !== undefined} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<span key={`t${last}`}>{plain(text.slice(last))}</span>);
  return out;
}

/** A symbol or transcription that is LaTeX without delimiters. */
export function looksLikeTex(s: string): boolean {
  return /\\[a-zA-Z]+|[_^]\{|[_^][a-zA-Z0-9]/.test(s);
}

/** The selected text, with any whole formula in it given as its LaTeX. */
export function selectedText(sel: Selection): string {
  if (!sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  const frag = range.cloneContents();
  for (const el of [...frag.querySelectorAll<HTMLElement>("[data-tex]")]) el.replaceWith(`\\(${el.dataset.tex}\\)`);
  // Formulas the selection only partly covers are cloned with their data-tex too, and so come
  // out whole above; a selection entirely inside one formula is that formula.
  const inside = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>("[data-tex]");
  if (inside) return `\\(${inside.dataset.tex}\\)`;
  // Separate blocks (a part's symbol, name and note) with a space, so words don't run together.
  for (const el of [...frag.querySelectorAll("div, p, li, h1, h2, h3, h4, br")]) el.append(" ");
  const div = document.createElement("div");
  div.append(frag);
  return div.textContent ?? "";
}

/** An element's text, with each formula in it given as its LaTeX. */
export function textWithTex(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const m of [...copy.querySelectorAll<HTMLElement>("[data-tex]")]) m.replaceWith(`\\(${m.dataset.tex}\\)`);
  return copy.textContent ?? "";
}
