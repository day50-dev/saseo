// Who is using the page. With accounts off (a local copy), everyone is the one local user.
import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import { createContext, useContext } from "react";

export interface Me {
  accounts: boolean;
  providers: string[];
  /** anonymous: not signed in; their canvases last as long as this browser's cookie. */
  user: { id: string; email: string; name: string; admin: boolean; anonymous: boolean } | null;
  /** The server can listen and speak, so calls with the librarian are possible. */
  /** Speech servers this server has; a browser's own speech covers what's missing. */
  speech?: { tts: boolean; stt: boolean };
}

export const authClient = createAuthClient({ baseURL: location.origin, plugins: [anonymousClient()] });

/** A visitor who isn't signed in gets an anonymous account, so they can start straight away. */
export async function startAnonymously(): Promise<void> {
  const res = await authClient.signIn.anonymous();
  if (res.error) throw new Error(res.error.message ?? "couldn't start a session");
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch("/api/me");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Me>;
}

export async function signOut() {
  await authClient.signOut();
  location.href = "/";
}

const LOCAL: Me = { accounts: false, providers: [], user: { id: "local", email: "", name: "You", admin: true, anonymous: false } };
export const MeContext = createContext<Me>(LOCAL);
export const useMe = () => useContext(MeContext);
/** Whether this person may see and change the shared models and searchers. */
export const useIsAdmin = () => useMe().user?.admin ?? false;
/** Not signed in, on a server with accounts: what they make isn't kept until they sign in. */
export const useIsAnonymous = () => useMe().user?.anonymous ?? false;
