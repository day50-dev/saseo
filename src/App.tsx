import { useEffect, useState } from "react";
import { Canvas } from "./Canvas.tsx";
import { Home } from "./Home.tsx";
import { Join } from "./Join.tsx";
import { linkTo, useRoute } from "./router.ts";
import { fetchMe, type Me, MeContext, startAnonymously } from "./session.ts";
import { Settings } from "./Settings.tsx";
import { SignIn } from "./SignIn.tsx";

export function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      let me = await fetchMe();
      // Nobody signed in: start anonymously, so they can try it at once. Signing in is for keeping things.
      if (me.accounts && !me.user && location.pathname !== "/signin" && location.pathname !== "/signup") {
        await startAnonymously();
        me = await fetchMe();
      }
      // Arriving from the old address: bring along what you had there, then go where you were going.
      if (location.pathname === "/handoff") {
        const q = new URLSearchParams(location.search);
        const to = q.get("to") ?? "/";
        await fetch("/api/handoff/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: q.get("t") }) }).catch(() => {});
        history.replaceState(null, "", to.startsWith("/") && !to.startsWith("//") ? to : "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      setMe(me);
    })().catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="error">Couldn't reach the server: {error}</p>;
  if (!me) return <p className="muted" style={{ padding: 32 }}>Loading…</p>;
  if (route.page === "signin" || (me.accounts && !me.user)) return <SignIn providers={me.providers} anonymous={Boolean(me.user?.anonymous)} />;

  let page;
  if (route.page === "settings") page = <Settings />;
  else if (route.page === "join") page = <Join token={route.token} />;
  // Keyed by id so switching canvases starts fresh: its own view, its own undo history.
  else if (route.page === "canvas") page = <Canvas key={route.id} canvasId={route.id} />;
  else if (route.page === "missing")
    page = (
      <main className="settings">
        <h1>Not found</h1>
        <p>
          <a {...linkTo("/")}>All canvases</a>
        </p>
      </main>
    );
  else page = <Home />;
  return <MeContext.Provider value={me}>{page}</MeContext.Provider>;
}
