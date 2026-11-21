import { useEffect, useState } from "react";
import type { CanvasInfo } from "../shared/canvas.ts";
import { canvasesApi } from "./canvasApi.ts";
import { linkTo, navigate } from "./router.ts";
import { signOut, useIsAdmin, useMe } from "./session.ts";

/** The list of canvases; each opens at its own stable URL. */
export function Home() {
  const [list, setList] = useState<CanvasInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const me = useMe();
  const admin = useIsAdmin();

  useEffect(() => {
    document.title = "Librarian";
    canvasesApi.list().then(setList, (e) => setError(String(e)));
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const c = await canvasesApi.create(name);
      navigate(`/c/${c.id}`);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <main className="settings home">
      <header className="home-head">
        <h1>Librarian</h1>
        <span className="home-links">
          {admin && <a {...linkTo("/settings")}>Settings</a>}
          {me.accounts && me.user && (
            <>
              <span className="muted small">{me.user.email}</span>
              <button type="button" className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </span>
      </header>
      {error && <p className="error">{error}</p>}
      <form className="row new-canvas" onSubmit={create}>
        <input value={name} placeholder="Name a new canvas, e.g. CSS talk, Sobolev inequalities" onChange={(e) => setName(e.target.value)} />
        <button type="submit">New canvas</button>
      </form>
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">No canvases yet. Name one above to start.</p>
      ) : (
        <ul className="canvas-list">
          {[...list].reverse().map((c) => (
            <li key={c.id}>
              <a {...linkTo(`/c/${c.id}`)}>{c.name}</a>
              <span className="muted small">
                {" "}
                · /c/{c.id} · started {new Date(c.createdAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
