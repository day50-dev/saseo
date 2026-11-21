// Fetching a page someone links to, safely, and pulling out its readable text.
//
// On a public server, a link a user types makes the server fetch it, which could be aimed at
// addresses inside the server's own network. So only public http(s) addresses are fetched,
// every redirect is checked the same way, and the size and time are capped.
import { lookup } from "node:dns/promises";
import net from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const USER_AGENT = "librarian (open-source study tool; https://github.com/kristopolous/librarian)";
const MAX_BYTES = 3_000_000;
const MAX_TEXT = 24_000;
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
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT);

/** Wikipedia's own API gives clean text, with formulas as LaTeX, rather than the page's HTML. */
async function readWikipedia(url: URL): Promise<ReadPage | null> {
  const m = url.pathname.match(/^\/wiki\/(.+)$/);
  if (!m || !/(^|\.)wikipedia\.org$/.test(url.hostname)) return null;
  const title = decodeURIComponent(m[1]).replace(/_/g, " ");
  const api = new URL(`https://${url.hostname}/w/api.php`);
  for (const [k, v] of Object.entries({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", titles: title, format: "json", formatversion: "2" })) {
    api.searchParams.set(k, v);
  }
  const { body } = await fetchPublic(api.toString());
  const page = JSON.parse(body)?.query?.pages?.[0];
  if (!page?.extract) return null;
  // Section headings come as "== Heading =="; keep them as plain headings.
  const text = String(page.extract).replace(/^=+\s*(.+?)\s*=+$/gm, "\n$1\n");
  return { url: `https://${url.hostname}/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`, title: page.title, site: "Wikipedia", text: tidy(text) };
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
  const article = new Readability(document as unknown as Document).parse();
  const text = tidy(article?.textContent ?? "");
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
