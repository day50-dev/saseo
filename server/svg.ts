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
