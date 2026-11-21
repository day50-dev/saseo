import { useCallback, useEffect, useState } from "react";
import type { CanvasSummary } from "../shared/canvas.ts";
import { canvasesApi } from "./canvasApi.ts";
import { linkTo, navigate } from "./router.ts";
import { signOut, useIsAdmin, useMe } from "./session.ts";

/** "3 minutes ago", "yesterday", or a date. */
export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  return new Date(iso).toLocaleDateString();
}

/** Your canvases: open, rename, duplicate, or move to the trash, which keeps everything. */
export function Home() {
  const [list, setList] = useState<CanvasSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const me = useMe();
  const admin = useIsAdmin();

  const load = useCallback(() => {
    canvasesApi.list().then(setList, (e) => setError(String(e)));
  }, []);

  useEffect(() => {
    document.title = "Librarian";
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const c = await canvasesApi.create(name);
      navigate(`/c/${c.id}`);
    } catch (err) {
      setError(String(err));
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (err) {
      setError(String(err));
    }
  };

  const live = list?.filter((c) => !c.trashedAt) ?? [];
  const trashed = list?.filter((c) => c.trashedAt) ?? [];

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
      {error && (
        <p className="error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      <form className="row new-canvas" onSubmit={create}>
        <input value={name} placeholder="Name a new canvas, e.g. CSS talk, Sobolev inequalities" onChange={(e) => setName(e.target.value)} />
        <button type="submit">New canvas</button>
      </form>
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : live.length === 0 ? (
        <p className="muted">No canvases yet. Name one above to start.</p>
      ) : (
        <ul className="canvas-list">
          {live.map((c) => (
            <CanvasRow
              key={c.id}
              canvas={c}
              onRename={(n) => act(() => canvasesApi.rename(c.id, n))}
              onDuplicate={() => act(() => canvasesApi.duplicate(c.id))}
              onTrash={() => act(() => canvasesApi.trash(c.id, true))}
            />
          ))}
        </ul>
      )}
      {trashed.length > 0 && (
        <details className="trash">
          <summary>
            Trash ({trashed.length}) <span className="muted small">· nothing here is deleted; restore any time</span>
          </summary>
          <ul className="canvas-list">
            {trashed.map((c) => (
              <li key={c.id} className="canvas-row">
                <div className="canvas-main">
                  <a {...linkTo(`/c/${c.id}`)} className="canvas-title">
                    {c.name}
                  </a>
                  <div className="muted small">
                    {summary(c)} · trashed {ago(c.trashedAt!)}
                  </div>
                </div>
                <div className="canvas-actions">
                  <button type="button" className="secondary" onClick={() => act(() => canvasesApi.trash(c.id, false))}>
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

const summary = (c: CanvasSummary) =>
  `${c.cards} ${c.cards === 1 ? "card" : "cards"} · ${c.pages} ${c.pages === 1 ? "page" : "pages"} · changed ${ago(c.updatedAt)}`;

function CanvasRow(props: {
  canvas: CanvasSummary;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onTrash: () => void;
}) {
  const { canvas: c } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.name);
  const done = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== c.name) props.onRename(draft.trim());
  };
  return (
    <li className="canvas-row">
      <div className="canvas-main">
        {editing ? (
          <input
            autoFocus
            className="canvas-name-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={done}
            onKeyDown={(e) => {
              if (e.key === "Enter") done();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <a {...linkTo(`/c/${c.id}`)} className="canvas-title">
            {c.name}
          </a>
        )}
        <div className="muted small">{summary(c)}</div>
      </div>
      <div className="canvas-actions">
        <button type="button" className="link" onClick={() => (setDraft(c.name), setEditing(true))}>
          Rename
        </button>
        <button type="button" className="link" onClick={props.onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="link" title="Move to the trash; you can restore it" onClick={props.onTrash}>
          Trash
        </button>
      </div>
    </li>
  );
}
