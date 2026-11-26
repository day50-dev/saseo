// The administrator password. The models, searchers and their API keys are shared by everyone using
// this copy, so seeing or changing them takes this password, whether or not accounts are on: a
// copy shared with someone must not hand them its keys, or let them point the keys at their own server.
//
// The password is ADMIN_PASSWORD when that's set; otherwise one is made on first start and kept in
// data/admin-password (readable only by its owner), where whoever runs the server can read it, and
// change it later in Settings. Unlocking sets a cookie signed with a key kept beside it, so changing
// the password locks out every browser that had the old one.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");
const PASSWORD_FILE = path.join(DATA_DIR, "admin-password");
const KEY_FILE = path.join(DATA_DIR, "admin-key");
export const ADMIN_COOKIE = "saseo_admin";
/** How long an unlocked browser stays unlocked. */
const MAX_AGE = 30 * 24 * 3600;

/** Set by ADMIN_PASSWORD, so it can't be changed from Settings. */
export const PASSWORD_FROM_ENV = Boolean(process.env.ADMIN_PASSWORD);

function readOrMake(file: string, make: () => string): { value: string; made: boolean } {
  try {
    const value = readFileSync(file, "utf8").trim();
    if (value) return { value, made: false };
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true });
  const value = make();
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return { value, made: true };
}

const WORDS = "amber birch cedar delta ember fjord garnet harbor indigo juniper kestrel lantern meadow nimbus orchard pebble quartz raven saffron tundra umber violet willow yarrow zephyr atlas basalt cobalt drift falcon glacier heron".split(" ");
/** Four words and a number: easy to type, and about 30 bits, which at one guess a second takes decades. */
const newPassword = () => [...Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]), String(randomInt(100, 1000))].join("-");

const key = readOrMake(KEY_FILE, () => randomBytes(32).toString("hex")).value;
let password = process.env.ADMIN_PASSWORD ?? "";
if (!password) {
  const p = readOrMake(PASSWORD_FILE, newPassword);
  password = p.value;
  if (p.made) console.log(`Administrator password (for Settings): ${password}  — kept in ${PASSWORD_FILE}`);
}

const token = () => createHmac("sha256", key).update(`admin:${password}`).digest("base64url");

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function cookieValue(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

/** Whether this browser has unlocked with the administrator password. */
export const isAdmin = (req: Request) => same(cookieValue(req, ADMIN_COOKIE), token());

const secure = (process.env.BETTER_AUTH_URL ?? "").startsWith("https:") ? "; Secure" : "";
const unlockedCookie = () => `${ADMIN_COOKIE}=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
export const lockedCookie = () => `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;

// Wrong guesses wait a second each, one at a time across everyone, so guessing is slow.
let queue: Promise<unknown> = Promise.resolve();

/** The cookie to set when `guess` is the password, else null (after a pause). */
export function unlock(guess: string): Promise<string | null> {
  const attempt = queue.then(async () => {
    if (same(guess, password)) return unlockedCookie();
    await new Promise((r) => setTimeout(r, 1000));
    return null;
  });
  queue = attempt.catch(() => {});
  return attempt;
}

/** Changes the password (not when ADMIN_PASSWORD sets it); returns the new cookie for this browser. */
export function changePassword(next: string): string {
  if (PASSWORD_FROM_ENV) throw new Error("the password is set by ADMIN_PASSWORD on the server");
  const p = next.trim();
  if (p.length < 8) throw new Error("use at least 8 characters");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PASSWORD_FILE, `${p}\n`, { mode: 0o600 });
  password = p;
  return unlockedCookie();
}
