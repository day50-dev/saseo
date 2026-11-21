// Cleans an SVG a model drew. The page shows diagrams as <img src="data:image/svg+xml,…">, where the
// browser runs no scripts and loads nothing external; this is a second layer that strips anything
// active before it is stored, keeping only drawing elements.

const ALLOWED = new Set([
  "svg", "g", "defs", "title", "desc", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "path", "text", "tspan", "marker", "lineargradient", "radialgradient", "stop", "clippath", "use",
]);

const MAX_BYTES = 200_000;

export function sanitizeSvg(raw: string): string | null {
  const start = raw.search(/<svg[\s>]/i);
  const end = raw.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) return null;
  let svg = raw.slice(start, end + "</svg>".length);
  if (svg.length > MAX_BYTES) return null;

  // Drop whole elements whose content is not drawing: scripts, styles, embedded HTML, comments.
  svg = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<(script|style|foreignObject|iframe|object|embed|image|a|animate\w*|set)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|foreignObject|iframe|object|embed|image|a|animate\w*|set)\b[^>]*\/?>/gi, "");

  // Keep only allowed tags, and on them drop event handlers and any reference that isn't local.
  svg = svg.replace(/<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g, (_m, close: string, name: string, attrs: string) => {
    if (!ALLOWED.has(name.toLowerCase())) return "";
    if (close) return `</${name}>`;
    const kept = attrs
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\s+(xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _x, _q, a, b) => ((a ?? b ?? "").startsWith("#") ? m : ""))
      .replace(/\s+style\s*=\s*("[^"]*"|'[^']*')/gi, (m) => (/url\s*\(|expression|javascript:/i.test(m) ? "" : m))
      .replace(/javascript:/gi, "");
    return `<${name}${kept}>`;
  });

  // An image needs the namespace to render; models often leave it out.
  if (!/^<svg[^>]*\sxmlns=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

/**
 * Turns an SVG still being written into one that draws: drops the half-written last tag, closes
 * every element left open, then cleans it. Each frame shows everything finished so far.
 */
export function partialSvg(streamed: string): string | null {
  const start = streamed.search(/<svg[\s>]/i);
  if (start < 0) return null;
  let svg = streamed.slice(start);
  const end = svg.toLowerCase().lastIndexOf("</svg>");
  if (end >= 0) return sanitizeSvg(svg.slice(0, end + 6));
  // Cut back to the last complete tag; text after it may be a half-written word, which is fine
  // inside <text> but not elsewhere, so keep it only when it isn't the start of a tag.
  const lastOpen = svg.lastIndexOf("<");
  const lastClose = svg.lastIndexOf(">");
  if (lastOpen > lastClose) svg = svg.slice(0, lastOpen);
  if (!svg.includes(">")) return null;
  const open: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      const i = open.lastIndexOf(name);
      if (i >= 0) open.length = i;
    } else open.push(name);
  }
  return sanitizeSvg(svg + open.reverse().map((n) => `</${n}>`).join(""));
}

/** The title and caption a diagram carries in its own <title> and <desc>. */
export function svgLabels(svg: string): { title: string; caption: string } {
  const pick = (tag: string) =>
    (svg.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return { title: pick("title"), caption: pick("desc") };
}
