// Zotero: a reader links their library (OAuth 1.0a, Zotero's own sign-in), then Saseo can list what's
// in it and add the papers and pages it finds, into a "Saseo" collection.
//
// The app's client key and secret come from ZOTERO_CLIENT_KEY / ZOTERO_CLIENT_SECRET, or from
// data/zotero-app.json ({"key": "...", "secret": "..."}), read each time so it can be set without a
// restart. Register the app at https://www.zotero.org/oauth/apps with the callback
// <site>/api/zotero/callback. Each reader's link (their API key, user ID and name) is kept in
// data/zotero/<user>.json, readable only by the server.
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");
const OAUTH = process.env.ZOTERO_OAUTH_URL ?? "https://www.zotero.org/oauth";
const API = process.env.ZOTERO_API_URL ?? "https://api.zotero.org";
/** Where what Saseo adds goes, made the first time it's needed. */
export const COLLECTION = "Saseo";

interface AppKeys {
  key: string;
  secret: string;
}

async function appKeys(): Promise<AppKeys | null> {
  if (process.env.ZOTERO_CLIENT_KEY && process.env.ZOTERO_CLIENT_SECRET) {
    return { key: process.env.ZOTERO_CLIENT_KEY, secret: process.env.ZOTERO_CLIENT_SECRET };
  }
  try {
    const k = JSON.parse(await readFile(path.join(DATA_DIR, "zotero-app.json"), "utf8")) as Partial<AppKeys>;
    return k.key && k.secret ? { key: String(k.key).trim(), secret: String(k.secret).trim() } : null;
  } catch {
    return null;
  }
}

/** Whether this server can offer Zotero at all. */
export async function zoteroAvailable(): Promise<boolean> {
  return (await appKeys()) !== null;
}

// ---- OAuth 1.0a ----

/** RFC 3986 percent-encoding, as OAuth signs it. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The HMAC-SHA1 signature of a request: its method, URL and every OAuth and query parameter. */
export function oauthSignature(method: string, url: string, params: Record<string, string>, consumerSecret: string, tokenSecret = ""): string {
  const u = new URL(url);
  const all: [string, string][] = [...Object.entries(params), ...u.searchParams.entries()];
  const norm = all
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(norm)].join("&");
  return createHmac("sha1", `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest("base64");
}

/** POSTs a signed OAuth request and reads the form-encoded answer. */
async function oauthPost(url: string, app: AppKeys, extra: Record<string, string>, tokenSecret = ""): Promise<URLSearchParams> {
  const params: Record<string, string> = {
    oauth_consumer_key: app.key,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extra,
  };
  params.oauth_signature = oauthSignature("POST", url, params, app.secret, tokenSecret);
  const header = `OAuth ${Object.entries(params)
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(", ")}`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: header }, signal: AbortSignal.timeout(20_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`Zotero said: HTTP ${res.status} ${body.slice(0, 200)}`.trim());
  return new URLSearchParams(body);
}

/** Sign-ins under way: the temporary token's secret, whose they are, and where to go after. */
const pending = new Map<string, { secret: string; user: string; back: string; at: number }>();
const PENDING_MS = 30 * 60_000;

/** Only a path on this site, so the sign-in can't be used to send someone elsewhere. */
export const safeBack = (back: string | undefined) => (back && /^\/(?![/\\])/.test(back) ? back : "/zotero");

/** Starts linking: returns the Zotero page to send the reader to. */
export async function beginLink(user: string, callback: string, back: string): Promise<string> {
  const app = await appKeys();
  if (!app) throw new Error("Zotero isn't set up on this server");
  const now = Date.now();
  for (const [k, p] of pending) if (now - p.at > PENDING_MS) pending.delete(k);
  const r = await oauthPost(`${OAUTH}/request`, app, { oauth_callback: callback });
  const token = r.get("oauth_token");
  const secret = r.get("oauth_token_secret");
  if (!token || !secret) throw new Error("Zotero didn't start the sign-in");
  pending.set(token, { secret, user, back: safeBack(back), at: now });
  const q = new URLSearchParams({ oauth_token: token, library_access: "1", notes_access: "0", write_access: "1", name: "Saseo" });
  return `${OAUTH}/authorize?${q}`;
}

export interface ZoteroLink {
  /** The API key Zotero made for Saseo on this reader's account. */
  key: string;
  userID: string;
  username: string;
  /** The "Saseo" collection, once made or found. */
  collection?: string;
}

const linkFile = (user: string) => path.join(DATA_DIR, "zotero", `${user.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

export async function getLink(user: string): Promise<ZoteroLink | null> {
  try {
    return JSON.parse(await readFile(linkFile(user), "utf8")) as ZoteroLink;
  } catch {
    return null;
  }
}

async function saveLink(user: string, link: ZoteroLink) {
  const file = linkFile(user);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(`${file}.tmp`, JSON.stringify(link), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/** Finishes linking, back from Zotero. Returns where to send the reader. */
export async function finishLink(user: string, token: string, verifier: string): Promise<string> {
  const p = pending.get(token);
  if (!p || p.user !== user) throw new Error("That Zotero sign-in has expired or belongs to someone else. Try connecting again.");
  pending.delete(token);
  const app = await appKeys();
  if (!app) throw new Error("Zotero isn't set up on this server");
  const r = await oauthPost(`${OAUTH}/access`, app, { oauth_token: token, oauth_verifier: verifier }, p.secret);
  const key = r.get("oauth_token");
  const userID = r.get("userID");
  if (!key || !userID) throw new Error("Zotero didn't give Saseo access");
  await saveLink(user, { key, userID, username: r.get("username") ?? "" });
  return p.back;
}

/** Unlinks, and asks Zotero to delete the key it made, so nothing is left with access. */
export async function unlink(user: string) {
  const link = await getLink(user);
  if (!link) return;
  await fetch(`${API}/keys/current`, { method: "DELETE", headers: { "Zotero-API-Key": link.key, "Zotero-API-Version": "3" }, signal: AbortSignal.timeout(15_000) }).catch(() => {});
  await rm(linkFile(user), { force: true });
}

/** When an anonymous reader signs in, their link comes with what they made. */
export async function moveLink(from: string, to: string) {
  const link = await getLink(from);
  if (!link || (await getLink(to))) return;
  await saveLink(to, link);
  await rm(linkFile(from), { force: true });
}

// ---- The library ----

async function api<T>(link: ZoteroLink, user: string, p: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/users/${link.userID}${p}`, {
    ...init,
    headers: { "Zotero-API-Key": link.key, "Zotero-API-Version": "3", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 403) {
    // The reader revoked Saseo's key on zotero.org: forget the link, so they're asked to connect again.
    await rm(linkFile(user), { force: true });
    throw new Error("Zotero no longer lets Saseo in. Connect your library again.");
  }
  if (!res.ok) throw new Error(`Zotero said: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`.trim());
  return (await res.json()) as T;
}

interface Creator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

interface ZItem {
  key: string;
  data: {
    itemType: string;
    title?: string;
    creators?: Creator[];
    date?: string;
    url?: string;
    DOI?: string;
    abstractNote?: string;
    publicationTitle?: string;
    websiteTitle?: string;
  };
}

/** An item of a reader's library, as the page lists it. */
export interface LibraryItem {
  key: string;
  type: string;
  title: string;
  authors: string[];
  year: string;
  /** Where to read it: its URL, or its DOI's. */
  url: string;
  abstract: string;
  where: string;
}

const creatorName = (c: Creator) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ");

function libraryItem(i: ZItem): LibraryItem {
  const d = i.data;
  return {
    key: i.key,
    type: d.itemType,
    title: d.title ?? "",
    authors: (d.creators ?? []).map(creatorName).filter(Boolean),
    year: d.date?.match(/\d{4}/)?.[0] ?? "",
    url: d.url || (d.DOI ? `https://doi.org/${d.DOI}` : ""),
    abstract: d.abstractNote ?? "",
    where: d.publicationTitle ?? d.websiteTitle ?? "",
  };
}

/** The newest items in a reader's library, or those matching `q` (titles, authors, years). */
export async function listLibrary(user: string, q = "", start = 0): Promise<{ username: string; items: LibraryItem[] }> {
  const link = await getLink(user);
  if (!link) throw new Error("Your Zotero library isn't connected");
  const query = new URLSearchParams({ limit: "30", start: String(start), sort: "dateModified", direction: "desc", format: "json" });
  if (q.trim()) query.set("q", q.trim());
  const items = await api<ZItem[]>(link, user, `/items/top?${query}`);
  return { username: link.username, items: items.filter((i) => i.data.itemType !== "note" && i.data.itemType !== "attachment").map(libraryItem) };
}

/** Something found on a canvas, to add to Zotero. */
export interface ToAdd {
  url: string;
  title: string;
  authors?: string[];
  /** "2024-03-01" or a year. */
  date?: string;
  abstract?: string;
  /** An arXiv ID: added as a preprint. Otherwise it's a web page. */
  arxiv?: string;
}

interface WriteResult {
  successful?: Record<string, { key: string }>;
  failed?: Record<string, { message?: string }>;
}

/** The "Saseo" collection's key: remembered, or found by name, or made. */
async function collectionKey(user: string, link: ZoteroLink): Promise<string> {
  if (link.collection) return link.collection;
  const top = await api<{ key: string; data: { name: string } }[]>(link, user, "/collections/top?limit=100");
  let key = top.find((c) => c.data.name === COLLECTION)?.key;
  if (!key) {
    const r = await api<WriteResult>(link, user, "/collections", { method: "POST", body: JSON.stringify([{ name: COLLECTION }]) });
    key = r.successful?.["0"]?.key;
    if (!key) throw new Error(`Couldn't make the ${COLLECTION} collection in Zotero`);
  }
  await saveLink(user, { ...link, collection: key });
  return key;
}

/** A name as Zotero keeps an author: last name apart when there is one. */
function creator(name: string): Creator {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? { creatorType: "author", firstName: parts.slice(0, -1).join(" "), lastName: parts.at(-1)! } : { creatorType: "author", name: name.trim() };
}

const sameUrl = (a: string, b: string) => a.replace(/^https?:\/\/(www\.)?|\/$/g, "") === b.replace(/^https?:\/\/(www\.)?|\/$/g, "");

/** Adds a paper or page to the reader's library, in the Saseo collection. Already there: says so. */
export async function addToLibrary(user: string, it: ToAdd, retried = false): Promise<{ key: string; already: boolean }> {
  const link = await getLink(user);
  if (!link) throw new Error("Your Zotero library isn't connected");
  if (!/^https?:\/\//.test(it.url)) throw new Error("Only a web address can be added");
  const title = it.title.trim().slice(0, 500) || it.url;
  // Already in the library (same address, or same title)? Don't make a second copy.
  const near = await api<ZItem[]>(link, user, `/items/top?${new URLSearchParams({ q: title.slice(0, 120), limit: "10", format: "json" })}`);
  const same = near.find((i) => (i.data.url && sameUrl(i.data.url, it.url)) || (i.data.title ?? "").trim().toLowerCase() === title.toLowerCase());
  if (same) return { key: same.key, already: true };
  const collection = await collectionKey(user, link);
  const today = new Date().toISOString().slice(0, 10);
  const item = it.arxiv
    ? {
        itemType: "preprint",
        title,
        creators: (it.authors ?? []).map(creator),
        abstractNote: it.abstract ?? "",
        date: it.date ?? "",
        url: it.url,
        repository: "arXiv",
        archiveID: `arXiv:${it.arxiv}`,
        accessDate: today,
        collections: [collection],
      }
    : {
        itemType: "webpage",
        title,
        creators: (it.authors ?? []).map(creator),
        abstractNote: it.abstract ?? "",
        date: it.date ?? "",
        url: it.url,
        websiteTitle: new URL(it.url).hostname.replace(/^www\./, ""),
        accessDate: today,
        collections: [collection],
      };
  const r = await api<WriteResult>(link, user, "/items", { method: "POST", body: JSON.stringify([item]) });
  const key = r.successful?.["0"]?.key;
  if (key) return { key, already: false };
  const why = r.failed?.["0"]?.message ?? "no reason given";
  // The reader deleted the Saseo collection: forget it, and make it again.
  if (/collection/i.test(why) && link.collection && !retried) {
    await saveLink(user, { ...link, collection: undefined });
    return addToLibrary(user, it, true);
  }
  throw new Error(`Zotero didn't take it: ${why}`);
}
