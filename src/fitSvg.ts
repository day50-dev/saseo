// A drawn diagram's frame (its viewBox) widened to hold everything drawn: models often put a label
// past the edge ("Positi…"), and an SVG shown as an image cuts off whatever is outside its frame.

const fitted = new Map<string, string>();

/** The SVG with its viewBox grown, if needed, to hold all it draws, plus a small margin. */
export function fitSvg(svg: string): string {
  const known = fitted.get(svg);
  if (known !== undefined) return known;
  let out = svg;
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (root.nodeName.toLowerCase() === "svg" && !doc.querySelector("parsererror")) {
      const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
      const w = Number.parseFloat(root.getAttribute("width") ?? "");
      const h = Number.parseFloat(root.getAttribute("height") ?? "");
      const frame = vb.length === 4 && vb.every(Number.isFinite) ? vb : Number.isFinite(w) && Number.isFinite(h) ? [0, 0, w, h] : null;
      if (frame) {
        // Measured where it's drawn: in the page, out of sight, then taken away again. The SVG was
        // cleaned on the server (no scripts, handlers or outside links), and is only measured here.
        const host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        host.setAttribute("style", "position:absolute;left:-99999px;top:0;visibility:hidden");
        host.setAttribute("viewBox", frame.join(" "));
        for (const child of [...root.childNodes]) host.appendChild(document.importNode(child, true));
        document.body.appendChild(host);
        let box: DOMRect | null = null;
        try {
          box = host.getBBox();
        } finally {
          host.remove();
        }
        const [x, y, fw, fh] = frame;
        if (box && box.width > 0 && box.height > 0) {
          const pad = 8;
          const x0 = Math.min(x, box.x - pad);
          const y0 = Math.min(y, box.y - pad);
          const x1 = Math.max(x + fw, box.x + box.width + pad);
          const y1 = Math.max(y + fh, box.y + box.height + pad);
          if (x0 < x || y0 < y || x1 > x + fw || y1 > y + fh) {
            root.setAttribute("viewBox", `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
            // Sized by its frame from now on, so the wider drawing scales to fit the card.
            root.removeAttribute("width");
            root.removeAttribute("height");
            out = new XMLSerializer().serializeToString(root);
          }
        }
      }
    }
  } catch {
    // Shown as it came.
  }
  fitted.set(svg, out);
  return out;
}
