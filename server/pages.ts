// Fetching a page someone links to, safely, and pulling out its readable text.
//
// On a public server, a link a user types makes the server fetch it, which could be aimed at
// addresses inside the server's own network. So only public http(s) addresses are fetched,
// every redirect is checked the same way, and the size and time are capped.
import { lookup } from "node:dns/promises";
import net from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const USER_AGENT = "saseo (open-source study tool; https://github.com/day50-dev/saseo)";
const MAX_BYTES = 3_000_000;
// The whole page: even the longest Wikipedia articles are a few hundred thousand characters.
// Prompts take excerpts of it (see excerpt and shapePage in explain.ts).
const MAX_TEXT = 400_000;
const MAX_REDIRECTS = 4;

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/** Refuses anything but a public http(s) address on the usual ports. */
async function checkUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https links can be opened.");
  if (url.username || url.password) throw new Error("Links with a username or password can't be opened.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("Only links on the usual web ports can be opened.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("That link points inside a private network.");
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) throw new Error("That link points inside a private network.");
}

/** Fetches a public URL, following up to a few redirects, each checked, and reads at most MAX_BYTES. */
async function fetchPublic(start: string): Promise<{ url: URL; type: string; body: string }> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await checkUrl(url);
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`The page answered HTTP ${res.status}.`);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("That page is too large to read.");
      }
      chunks.push(value);
    }
    return { url, type: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("That link redirects too many times.");
}

export interface ReadPage {
  url: string;
  title: string;
  site: string;
  text: string;
}

const tidy = (s: string) =>
  s
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);

// Math is kept as LaTeX between \( \) (inline) or \[ \] (on its own line), which the canvas
// renders and the language model reads, instead of the flattened characters a page's text gives.

/** The LaTeX behind a math element: Wikipedia's source, a MathML annotation, or alt text. */
function texOf(el: Element): string {
  const mw = el.getAttribute("data-mw");
  if (mw) {
    try {
      const src = JSON.parse(mw)?.body?.extsrc;
      if (typeof src === "string") return src.trim();
    } catch {}
  }
  const note = el.querySelector('annotation[encoding="application/x-tex"]');
  if (note?.textContent) return note.textContent.trim();
  const alt = el.getAttribute("alttext") ?? "";
  return alt.replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, "$1").trim();
}

const escapeTex = (s: string) => s.replace(/[\\{}$&#%_^~]/g, (c) => (c === "\\" ? "\\backslash " : `\\${c}`));

/** Replaces every formula in the page with its LaTeX as text, before anything else reads it. */
function mathToTex(document: Document): void {
  const swap = (el: Element, tex: string, block: boolean) => {
    if (!tex) return;
    el.replaceWith(document.createTextNode(block ? ` \\[${tex}\\] ` : `\\(${tex}\\)`));
  };
  for (const el of [...document.querySelectorAll("math")]) {
    swap(el, texOf(el), el.getAttribute("display") === "block" || /math-element-block/.test(el.getAttribute("class") ?? ""));
  }
  // MathJax pages keep their source in script tags.
  for (const el of [...document.querySelectorAll('script[type^="math/tex"]')]) {
    swap(el, (el.textContent ?? "").trim(), /mode=display/.test(el.getAttribute("type") ?? ""));
  }
  // Wikipedia's lighter {{math}} formulas use HTML subscripts and superscripts.
  for (const el of [...document.querySelectorAll("sub, sup")]) {
    const t = (el.textContent ?? "").trim();
    if (!t || t.length > 20 || /reference/.test(el.getAttribute("class") ?? "")) continue;
    swap(el, `${el.tagName.toLowerCase() === "sub" ? "_" : "^"}{${escapeTex(t)}}`, false);
  }
}

const SKIP =
  "script, style, noscript, link, meta, nav, footer, form, button, .mw-editsection, .reference, .mw-references-wrap, .reflist, " +
  ".navbox, .sidebar, .vertical-navbox, .infobox, .side-box, .rightHandSide, .mw-heading .mw-editsection, .hatnote, .metadata, .ambox, .sistersitebox, .noprint, .shortdescription, .mw-cite-backlink, .mw-empty-elt";
const BLOCK = new Set(["p", "div", "section", "article", "dl", "dd", "dt", "ul", "ol", "table", "tr", "figure", "blockquote", "pre", "center"]);
const SKIP_SECTIONS = /^(references|notes|external links|further reading|see also|bibliography|citations|sources)$/i;

/** Plain text with paragraphs, "## " headings, bullets and images, from an element's HTML. */
function textOf(root: Element, base: URL): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      out.push((n.textContent ?? "").replace(/\s+/g, " "));
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.tagName.toLowerCase();
    if (el.matches(SKIP)) return;
    if (/^h[1-6]$/.test(tag)) {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) out.push(`\n\n## ${t}\n\n`);
      return;
    }
    if (tag === "section") {
      const h = el.querySelector(":scope > h2, :scope > h3, :scope > h4");
      if (h && SKIP_SECTIONS.test((h.textContent ?? "").trim())) return;
    }
    if (tag === "img") {
      // Diagrams carry much of the meaning in math pages; icons and spacers don't.
      const src = el.getAttribute("src") ?? "";
      const w = Number(el.getAttribute("width") ?? 999);
      if (!src || w < 40 || src.startsWith("data:")) return;
      try {
        const url = new URL(src, base);
        if (url.protocol !== "https:") return;
        const alt = (el.getAttribute("alt") ?? "").replace(/[\[\]\n]/g, " ").trim();
        out.push(`\n\n![${alt}](${url.toString()})\n\n`);
      } catch {}
      return;
    }
    if (tag === "br") return void out.push("\n");
    if (tag === "li") out.push("\n• ");
    const block = BLOCK.has(tag);
    if (block) out.push("\n\n");
    for (const c of el.childNodes) walk(c);
    if (block) out.push("\n\n");
    else if (tag === "td" || tag === "th") out.push(" ");
    else if (tag === "li") out.push("\n");
  };
  walk(root);
  // Displayed formulas stand on their own line.
  return tidy(out.join("").replace(/•\s*\n+/g, "• ").replace(/\s*\\\[([\s\S]*?)\\\]\s*/g, "\n\n\\[$1\\]\n\n"));
}

/** Wikipedia's own HTML keeps each formula's LaTeX source; its plain-text extract flattens them. */
async function readWikipedia(url: URL): Promise<ReadPage | null> {
  const m = url.pathname.match(/^\/wiki\/(.+)$/);
  if (!m || !/(^|\.)wikipedia\.org$/.test(url.hostname)) return null;
  const page = await fetchPublic(`https://${url.hostname}/api/rest_v1/page/html/${m[1]}`);
  const { document } = parseHTML(page.body);
  mathToTex(document as unknown as Document);
  const title = (document.querySelector("title")?.textContent ?? decodeURIComponent(m[1]).replace(/_/g, " ")).trim();
  const text = textOf(document.body as unknown as Element, page.url);
  if (!text) return null;
  return { url: `https://${url.hostname}/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, title, site: "Wikipedia", text };
}

/** The readable text of a public web page: its title and main content, without navigation and ads. */
export async function readPage(link: string): Promise<ReadPage> {
  const url = new URL(link.trim());
  const wiki = await readWikipedia(url);
  if (wiki) return wiki;
  const page = await fetchPublic(url.toString());
  if (/pdf/i.test(page.type)) {
    throw new Error(/arxiv\.org/.test(page.url.hostname) ? "That's an arXiv PDF: use the arXiv button to add its pages." : "PDF links can't be read yet.");
  }
  if (/text\/plain/i.test(page.type)) {
    return { url: page.url.toString(), title: page.url.pathname.split("/").pop() || page.url.hostname, site: page.url.hostname, text: tidy(page.body) };
  }
  const { document } = parseHTML(page.body);
  mathToTex(document as unknown as Document);
  // Readability drops class names, so side panels and tables of contents go first.
  for (const el of [...document.querySelectorAll(`${SKIP}, #toc, .toc, .maruku_toc, #Context`)]) el.remove();
  const article = new Readability(document as unknown as Document).parse();
  const text = article?.content ? textOf(parseHTML(`<!doctype html><html><body>${article.content}</body></html>`).document.body as unknown as Element, page.url) : "";
  if (!text) throw new Error("Couldn't find readable text on that page.");
  return {
    url: page.url.toString(),
    title: (article?.title ?? "").trim() || page.url.hostname,
    site: article?.siteName?.trim() || page.url.hostname.replace(/^www\./, ""),
    text,
  };
}

/** Whether what someone typed is a link rather than a statement. */
export function looksLikeLink(input: string): boolean {
  return /^https?:\/\/\S+$/i.test(input.trim());
}

/**
 * A page's tables, kept as tables (rows of cells joined with " | ", each under its caption), with
 * some of its prose for context. The readable text above flattens tables; figures need their rows.
 */
export async function readTables(link: string): Promise<{ url: string; title: string; tables: string[]; prose: string }> {
  const page = await fetchPublic(new URL(link.trim()).toString());
  if (!/html/i.test(page.type)) throw new Error("Not an HTML page.");
  const { document } = parseHTML(page.body);
  const cell = (el: Element) => (el.textContent ?? "").replace(/\[\d+\]|\[[a-z]\]/g, "").replace(/\s+/g, " ").trim();
  const tables: string[] = [];
  for (const t of [...document.querySelectorAll("table")] as unknown as Element[]) {
    if (t.closest(".navbox, .vertical-navbox, .sidebar, .metadata, .ambox, .sistersitebox")) continue;
    const rows = ([...t.querySelectorAll("tr")] as unknown as Element[])
      .map((tr) => ([...tr.querySelectorAll("th, td")] as unknown as Element[]).map(cell).join(" | "))
      .filter((r) => r.replace(/[ |]/g, ""));
    if (rows.length < 2) continue;
    const caption = cell((t.querySelector("caption") as unknown as Element) ?? t.ownerDocument.createElement("x"));
    tables.push([caption && `Table: ${caption}`, ...rows.slice(0, 80)].filter(Boolean).join("\n"));
  }
  for (const el of [...document.querySelectorAll(`${SKIP}, table, script, style, nav, header, footer, #toc`)]) el.remove();
  const prose = ((document.body?.textContent as string) ?? "").replace(/\s+/g, " ").trim().slice(0, 2500);
  return { url: page.url.toString(), title: (document.querySelector("title")?.textContent ?? page.url.hostname).trim(), tables, prose };
}
