import { useEffect, useState } from "react";
import { Canvas } from "./Canvas.tsx";
import { Home } from "./Home.tsx";
import { linkTo, useRoute } from "./router.ts";
import { fetchMe, type Me, MeContext } from "./session.ts";
import { Settings } from "./Settings.tsx";
import { SignIn } from "./SignIn.tsx";

export function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchMe().then(setMe, (e) => setError(String(e)));
  }, []);

  if (error) return <p className="error">Couldn't reach the server: {error}</p>;
  if (!me) return <p className="muted" style={{ padding: 32 }}>Loading…</p>;
  if (me.accounts && !me.user) return <SignIn providers={me.providers} />;

  let page;
  if (route.page === "settings") page = <Settings />;
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
