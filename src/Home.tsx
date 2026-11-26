import { useCallback, useEffect, useState } from "react";
import type { CanvasSummary } from "../shared/canvas.ts";
import { Examples } from "./Canvas.tsx";
import { canvasesApi } from "./canvasApi.ts";
import type { Example } from "./examples.ts";
import { linkTo, navigate } from "./router.ts";
import { signOut, useIsAdmin, useIsAnonymous, useMe } from "./session.ts";

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
  const anonymous = useIsAnonymous();

  const load = useCallback(() => {
    canvasesApi.list().then(setList, (e) => setError(String(e)));
  }, []);

  useEffect(() => {
    document.title = "Saseo";
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

  // Deleting can't be undone, so it always asks first.
  const confirmDelete = (which: CanvasSummary[]) => {
    if (!which.length) return;
    const what = which.length === 1 ? `“${which[0].name}”` : `these ${which.length} canvases`;
    if (!window.confirm(`Delete ${what} for good? Everything on ${which.length === 1 ? "it" : "them"} is erased, and this can't be undone.`)) return;
    void act(async () => {
      for (const c of which) await canvasesApi.remove(c.id);
    });
  };
  const live = list?.filter((c) => !c.trashedAt) ?? [];
  const trashed = list?.filter((c) => c.trashedAt) ?? [];

  return (
    <main className="settings home">
      <header className="home-head">
        <h1>
          Saseo <span className="home-gloss" lang="ko" title="사서: Korean for librarian">사서</span>
        </h1>
        <span className="home-links">
          {admin && <a {...linkTo("/settings")}>Settings</a>}
          {anonymous && (
            <a {...linkTo("/signin")} className="save-link">
              Sign in to save your canvases
            </a>
          )}
          {me.accounts && me.user && !anonymous && (
            <>
              <span className="muted small">{me.user.email}</span>
              <button type="button" className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
        </span>
      </header>
      {anonymous && (
        <p className="muted small">
          Free, unlimited, no account needed. Your canvases are kept in this browser; sign in if you want to keep them for good.
        </p>
      )}
      <Explainer />
      {error && (
        <p className="error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      <form className="row new-canvas" onSubmit={create}>
        <input value={name} placeholder="Name a new canvas, e.g. CSS talk, Sobolev inequalities" onChange={(e) => setName(e.target.value)} />
        <button type="submit">New canvas</button>
      </form>
      <Examples
        onPick={async (ex: Example) => {
          try {
            const c = await canvasesApi.create(ex.title.slice(0, 60));
            navigate(`/c/${c.id}?example=${ex.key}`);
          } catch (err) {
            setError(String(err));
          }
        }}
      />
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
              onDelete={() => confirmDelete([c])}
            />
          ))}
        </ul>
      )}
      {trashed.length > 0 && (
        <details className="trash">
          <summary>
            Trash ({trashed.length}) <span className="muted small">· restore any time, or delete for good</span>
          </summary>
          <button type="button" className="link danger empty-trash" onClick={() => confirmDelete(trashed)}>
            Empty trash
          </button>
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
                  <button type="button" className="link danger" onClick={() => confirmDelete([c])}>
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      <footer className="home-foot muted small">
        Saseo is open source under the{" "}
        <a href="https://github.com/kristopolous/librarian/blob/main/LICENSE" target="_blank" rel="noreferrer">
          MIT license
        </a>
        . Copyright © 2026 Chris McKenzie ·{" "}
        <a href="https://github.com/kristopolous/librarian" target="_blank" rel="noreferrer">
          github.com/kristopolous/librarian
        </a>
      </footer>
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
  onDelete: () => void;
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
        <button type="button" className="link danger" title="Delete for good; this can't be undone" onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
}

/** The short video explainer of what Saseo is for, when this server has one. */
function Explainer() {
  const [has, setHas] = useState(false);
  useEffect(() => {
    fetch("/explainer.mp4", { method: "HEAD" }).then((r) => setHas(r.ok && (r.headers.get("content-type") ?? "").startsWith("video/")), () => {});
  }, []);
  if (!has) return null;
  return (
    <details className="explainer">
      <summary>What is this? Watch this short video</summary>
      <video src="/explainer.mp4" poster="/explainer.jpg" controls preload="none" playsInline />
    </details>
  );
}
