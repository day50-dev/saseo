import { Canvas } from "./Canvas.tsx";
import { Home } from "./Home.tsx";
import { linkTo, useRoute } from "./router.ts";
import { Settings } from "./Settings.tsx";

export function App() {
  const route = useRoute();
  if (route.page === "settings") return <Settings />;
  // Keyed by id so switching canvases starts fresh: its own view, its own undo history.
  if (route.page === "canvas") return <Canvas key={route.id} canvasId={route.id} />;
  if (route.page === "missing")
    return (
      <main className="settings">
        <h1>Not found</h1>
        <p>
          <a {...linkTo("/")}>All canvases</a>
        </p>
      </main>
    );
  return <Home />;
}
