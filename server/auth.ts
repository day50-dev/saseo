// Accounts, for running Librarian as a public site. Off unless LIBRARIAN_AUTH=on, so a local copy
// works exactly as before, single-user with no sign-in.
//
// On a server: anyone can sign up with email and password (no email service needed), and GitHub
// and Google sign-in appear when their OAuth keys are set. Accounts live in data/auth.db (SQLite).
// Emails in ADMIN_EMAILS manage the models and searchers everyone uses. SIGNUP_EMAILS, when set,
// limits who can create an account, so a private server doesn't spend its models on strangers.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";

export const AUTH_ON = process.env.LIBRARIAN_AUTH === "on";

const DATA_DIR = process.env.LIBRARIAN_DATA ?? path.resolve("data");

const emails = (v: string | undefined) =>
  new Set(
    (v ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
const ADMINS = emails(process.env.ADMIN_EMAILS);
/** Empty means anyone can sign up. */
const SIGNUP = emails(process.env.SIGNUP_EMAILS);

export interface User {
  id: string;
  email: string;
  name: string;
  admin: boolean;
}

/** Everyone, when accounts are off: the person running it on their own machine. */
export const LOCAL_USER: User = { id: "local", email: "", name: "You", admin: true };

/** Sessions are signed with this. Set BETTER_AUTH_SECRET in production; otherwise one is made and kept. */
function secret(): string {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  const file = path.join(DATA_DIR, "auth-secret");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    mkdirSync(DATA_DIR, { recursive: true });
    const s = randomBytes(32).toString("hex");
    writeFileSync(file, `${s}\n`, { mode: 0o600 });
    return s;
  }
}

const social: NonNullable<BetterAuthOptions["socialProviders"]> = {};
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  social.github = { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET };
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  social.google = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
}

/** Sign-in methods the page should offer. */
export const PROVIDERS = ["email", ...Object.keys(social)];

function options(): BetterAuthOptions {
  mkdirSync(DATA_DIR, { recursive: true });
  const baseURL = process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return {
    database: new Database(path.join(DATA_DIR, "auth.db")),
    baseURL,
    secret: secret(),
    // The dev server (5173) proxies to the API, so both origins are ours.
    trustedOrigins: [baseURL, "http://localhost:5173", "http://localhost:8787"],
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    socialProviders: social,
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (SIGNUP.size && !SIGNUP.has(user.email.toLowerCase())) {
              throw new APIError("FORBIDDEN", { message: "Sign-up is closed on this server." });
            }
          },
        },
      },
    },
  };
}

const config = AUTH_ON ? options() : null;
export const auth = config ? betterAuth(config) : null;

/** Creates or updates the account tables. Safe to run on every start. */
export async function initAuth(): Promise<void> {
  if (!config) return;
  const { runMigrations } = await getMigrations(config);
  await runMigrations();
}

/** Who is making this request: the signed-in user, nobody, or (accounts off) the local user. */
export async function currentUser(req: Request): Promise<User | null> {
  if (!auth) return LOCAL_USER;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  const { id, email, name } = session.user;
  return { id, email, name, admin: ADMINS.has(email.toLowerCase()) };
}
