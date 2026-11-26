import { useCallback, useEffect, useState } from "react";
import { Logo } from "./Logo.tsx";
import type { CanvasSummary, Sem } from "../shared/canvas.ts";
import { Examples } from "./Canvas.tsx";
import { canvasesApi } from "./canvasApi.ts";
import type { Example } from "./examples.ts";
import { SemShapes } from "./SemShapes.tsx";
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

  // A blank canvas: it asks what you want to start from, and names itself after that.
  const create = async () => {
    try {
      const c = await canvasesApi.create("");
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
          <Logo />
          Saseo
        </h1>
        <span className="home-links">
          {(admin || !me.accounts) && <a {...linkTo("/settings")}>Settings</a>}
          {anonymous && (
<span className="save-link">
              <a {...linkTo("/signup")}>Sign up</a> <span className="muted">|</span> <a {...linkTo("/signin")}>Sign in</a>
            </span>
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
      {/* Someone arriving cold learns what this is before anything asks them to act. */}
      <div className="home-pitch">
        <p className="home-tagline">Saseo explains the lecture, paper or page that went over your head.</p>
        <p className="muted">
          Paste a link or ask a question, then select any words you don't follow. A librarian writes you a card that
          explains them at your level, with its sources, and you can keep going deeper.
        </p>
      </div>
      {/* Then one button; the canvas it opens asks the same question, with the box. */}
      <div className="new-canvas home-start">
        <button type="button" onClick={create}>
          What's confusing you?
        </button>
      </div>
      {error && (
        <p className="error" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      {list === null ? (
        <p className="muted">Loading…</p>
      ) : (
        live.length > 0 && (
          <section className="home-canvases">
            <h2>Your canvases</h2>
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
          </section>
        )
      )}
      <Intro />
      <Explainer />
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
        <a href="https://github.com/day50-dev/saseo/blob/main/LICENSE" target="_blank" rel="noreferrer">
          MIT license
        </a>
        . Copyright © 2026 DA`/50 ·{" "}
        <a href="https://github.com/day50-dev/saseo" target="_blank" rel="noreferrer">
          github.com/day50-dev/saseo
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

/** Saseo explained the way it explains everything else: as a card, in its own shapes. */
const ABOUT: Sem = {
  why: [
    "The web got very good at getting your attention.",
    "Understanding something hard takes many sources, and you lose track of what you'd worked out.",
    "So: one place to take an idea apart and keep the pieces.",
  ],
  what: {
    gist: "An endless canvas where a librarian explains anything at your level, one piece at a time.",
    details: ["Bring a page, a paper, a lecture, a slide or just a question.", "Every explanation is written from sources it finds, and shows them."],
  },
  parts: [
    { symbol: "Select", meaning: "words you don't follow", note: "and they get a card of their own" },
    { symbol: "Call", meaning: "the librarian", note: "and talk while you point at things" },
    { symbol: "Pause", meaning: "a video", note: "and ask about what's on screen" },
    { symbol: "Share", meaning: "a canvas", note: "and see what a colleague changed" },
  ],
  together: "Every card is made like this one, so any piece of it can be taken apart in turn.",
  here: [
    "Paste a link or ask a question.",
    "Select the words that stop you, and a card explains them.",
    "Select inside that card to go a level deeper, as far as you need.",
    "Come back next week: everything is where you left it.",
  ],
  name: "",
};

/** What Saseo is: open on a first visit; behind "What is Saseo?" once there are canvases. */
function Intro() {
  return (
    <details className="intro">
      <summary>What is Saseo?</summary>
      <div className="intro-card">
        <SemShapes title="Saseo, a place for understanding" sem={ABOUT} render={(t) => t} labels={{ here: "How it unfolds" }} />
      </div>
    </details>
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
