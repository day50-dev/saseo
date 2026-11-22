// Marks the words in a card that have already been explained (or are being explained right now),
// so a selection leaves a visible trace where it was made. Uses the CSS Custom Highlight API, which
// paints ranges without touching the DOM React owns; browsers without it just show no marks.

type Kind = "explained" | "explaining";

const owned = new Map<string, Record<Kind, Range[]>>();

function repaint(kind: Kind) {
  const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !H) return;
  const all = [...owned.values()].flatMap((o) => o[kind]);
  if (all.length) reg.set(kind, new H(...all));
  else reg.delete(kind);
}

/** Finds the first place each phrase appears in the text under `roots`, ignoring differences in whitespace. */
export function findPhrases(roots: (Element | null)[], phrases: string[]): Range[] {
  const nodes: Text[] = [];
  for (const root of roots) {
    if (!root) continue;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      // Rendered formulas don't read as their source; skip them.
      acceptNode: (n) => ((n.parentElement?.closest(".katex, button, .descend") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n as Text);
  }
  // One flat string with whitespace collapsed, and where each of its characters came from.
  let flat = "";
  const from: { node: Text; at: number }[] = [];
  for (const node of nodes) {
    const s = node.data;
    for (let i = 0; i < s.length; i++) {
      const space = /\s/.test(s[i]);
      if (space && (flat.endsWith(" ") || flat === "")) continue;
      flat += space ? " " : s[i].toLowerCase();
      from.push({ node, at: i });
    }
    if (!flat.endsWith(" ") && flat) {
      // Text nodes in different blocks still read as separate words.
      flat += " ";
      from.push({ node, at: s.length });
    }
  }
  const ranges: Range[] = [];
  for (const phrase of phrases) {
    const p = phrase.replace(/\s+/g, " ").trim().toLowerCase();
    if (p.length < 2) continue;
    const i = flat.indexOf(p);
    if (i < 0) continue;
    const a = from[i];
    const b = from[i + p.length - 1];
    const r = document.createRange();
    r.setStart(a.node, a.at);
    r.setEnd(b.node, Math.min(b.at + 1, b.node.length));
    ranges.push(r);
  }
  return ranges;
}

/** Sets the marks one card owns. */
export function setMarks(owner: string, marks: Record<Kind, Range[]>) {
  owned.set(owner, marks);
  repaint("explained");
  repaint("explaining");
}

export function clearMarks(owner: string) {
  owned.delete(owner);
  repaint("explained");
  repaint("explaining");
}
