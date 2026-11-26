// Opening a share link: what it's to and who shared it, then join (a visitor gives a name first,
// so the owner can tell who changed what).
import { useEffect, useState } from "react";
import { canvasesApi } from "./canvasApi.ts";
import { linkTo } from "./router.ts";
import { useIsAnonymous, useMe } from "./session.ts";

export function Join({ token }: { token: string }) {
  const me = useMe();
  const anonymous = useIsAnonymous();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof canvasesApi.joinInfo>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(anonymous ? "" : (me.user?.name ?? ""));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    canvasesApi.joinInfo(token).then(setInfo, () => setError("This link doesn't work any more. Ask whoever sent it for a new one."));
  }, [token]);

  const join = async () => {
    setBusy(true);
    try {
      const { id } = await canvasesApi.join(token, name.trim());
      history.replaceState(null, "", `/c/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) {
      setError(`Couldn't join: ${e}`);
      setBusy(false);
    }
  };

  return (
    <main className="settings join">
      <p>
        <a {...linkTo("/")}>Saseo</a>
      </p>
      {error && <p className="error">{error}</p>}
      {!error && !info && <p className="muted">Loading…</p>}
      {info && (
        <>
          <h1>{info.name}</h1>
          <p>
            {info.ownerName} shared this canvas with you. You'll be able to {info.role === "editor" ? "add to it and change things on it" : "look at it, but not change it"}.
            {info.role === "editor" && <> What you change is marked as yours, so {info.ownerName} can see it when they come back.</>}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void join();
            }}
          >
            {anonymous && (
              <label className="join-name">
                Your name, as others will see it
                <input autoFocus value={name} maxLength={60} placeholder="e.g. Ana" onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            <button type="submit" disabled={busy || (anonymous && !name.trim())}>
              {info.already ? "Open it" : "Join and open it"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
