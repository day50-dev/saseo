// Who is using the page. With accounts off (a local copy), everyone is the one local user.
import { createAuthClient } from "better-auth/client";
import { createContext, useContext } from "react";

export interface Me {
  accounts: boolean;
  providers: string[];
  user: { id: string; email: string; name: string; admin: boolean } | null;
}

export const authClient = createAuthClient({ baseURL: location.origin });

export async function fetchMe(): Promise<Me> {
  const res = await fetch("/api/me");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Me>;
}

export async function signOut() {
  await authClient.signOut();
  location.href = "/";
}

const LOCAL: Me = { accounts: false, providers: [], user: { id: "local", email: "", name: "You", admin: true } };
export const MeContext = createContext<Me>(LOCAL);
export const useMe = () => useContext(MeContext);
/** Whether this person may see and change the shared models and searchers. */
export const useIsAdmin = () => useMe().user?.admin ?? false;
