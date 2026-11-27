// Zotero: the reader's library, linked with Zotero's own sign-in (server/zotero.ts). They can start a
// canvas from anything in it, and add what the librarian finds with the "Add to Zotero" button.
import { useEffect, useState } from "react";
import { canvasesApi } from "./canvasApi.ts";
import { giveTypedStart } from "./Canvas.tsx";
import { goBack, navigate } from "./router.ts";
import { useMe } from "./session.ts";

export interface LibraryItem {
  key: string;
  type: string;
  title: string;
  authors: string[];
  year: string;
  url: string;
  abstract: string;
  where: string;
}

export interface ToZotero {
  url: string;
  title: string;
  authors?: string[];
  date?: string;
  abstract?: string;
  arxiv?: string;
}

/** Off to Zotero's sign-in; back to `back` (this page, by default) afterwards. */
export function connectZotero(back = location.pathname) {
  location.href = `/api/zotero/connect?back=${encodeURIComponent(back)}`;
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/**
 * "Add to Zotero", when this server offers Zotero. Not linked yet: it takes them to Zotero's sign-in
 * and back to this canvas.
 */
export function AddToZotero({ item }: { item: ToZotero }) {
  const me = useMe();
  const [state, setState] = useState<"" | "adding" | "added" | "already" | string>("");
  if (!me.zotero || !/^https?:\/\//.test(item.url)) return null;
  const linked = Boolean(me.zotero.linked);
  const label = { "": "+ Zotero", adding: "Adding…", added: "In Zotero ✓", already: "Already in Zotero ✓" }[state] ?? "+ Zotero";
  return (
    <>
      <button
        type="button"
        className="link small add-zotero"
        disabled={state === "adding" || state === "added" || state === "already"}
        title={linked ? "Add this to your Zotero library, in the Saseo collection" : "Connect your Zotero library to add this to it"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={async () => {
          if (!linked) return connectZotero();
          setState("adding");
          try {
            const r = await json<{ already: boolean }>(
              await fetch("/api/zotero/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) }),
            );
            setState(r.already ? "already" : "added");
          } catch (err) {
            setState(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        {label}
      </button>
      {state && !["adding", "added", "already"].includes(state) && <span className="fail small"> {state}</span>}
    </>
  );
}

/** After Zotero's sign-in, the page it came back to says how it went, once. */
export function ZoteroNote() {
  const [note] = useState(() => new URLSearchParams(location.search).get("zotero"));
  const [shown, setShown] = useState(Boolean(note));
  useEffect(() => {
    if (!note) return;
    const q = new URLSearchParams(location.search);
    q.delete("zotero");
    history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
  }, [note]);
  if (!shown || !note) return null;
  return (
    <div className={`zotero-note ${note === "linked" ? "" : "fail"}`} role="status">
      {note === "linked" ? "Your Zotero library is connected." : note}
      <button type="button" className="link" onClick={() => setShown(false)} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

/** The page at /zotero: connect, or see the library and start a canvas from it. */
export function ZoteroPage() {
  const me = useMe();
  const linked = me.zotero?.linked ?? null;
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  const load = async (query: string, start = 0) => {
    setError(null);
    try {
      const r = await json<{ items: LibraryItem[] }>(await fetch(`/api/zotero/items?${new URLSearchParams({ q: query, start: String(start) })}`));
      setItems((prev) => (start ? [...(prev ?? []), ...r.items] : r.items));
      setMore(r.items.length >= 30);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    if (linked) void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  const open = async (it: LibraryItem) => {
    setOpening(it.key);
    try {
      const c = await canvasesApi.create(it.title.slice(0, 60));
      // A link is read as a page; without one, the title is asked about.
      giveTypedStart(c.id, it.url || it.title);
      navigate(`/c/${c.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setOpening(null);
    }
  };

  return (
    <main className="settings zotero-page">
      <p>
        <button type="button" className="link" onClick={goBack}>
          ← Back
        </button>
      </p>
      <h1>Zotero</h1>
      {!me.zotero ? (
        <p>Zotero isn't set up on this server.</p>
      ) : !linked ? (
        <section className="zotero-connect">
          <p>Open papers from your Zotero library on a canvas, and add what the librarian finds to it.</p>
          <button type="button" onClick={() => connectZotero()}>
            Connect your Zotero library
          </button>
        </section>
      ) : (
        <>
          <p className="zotero-who">
            Connected as <strong>{linked}</strong>. What you add goes in the Saseo collection.{" "}
            <button
              type="button"
              className="link"
              onClick={async () => {
                if (!window.confirm("Disconnect your Zotero library? Saseo's access to it is removed. Nothing in it is deleted.")) return;
                await fetch("/api/zotero", { method: "DELETE" });
                location.reload();
              }}
            >
              Disconnect
            </button>
          </p>
          <form
            className="zotero-search"
            onSubmit={(e) => {
              e.preventDefault();
              void load(q);
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your library: title, author, year" />
            <button type="submit" className="secondary">
              Search
            </button>
          </form>
          {error && <p className="fail">{error}</p>}
          {items === null && !error && <p className="muted">Loading your library…</p>}
          {items?.length === 0 && <p className="muted">{q ? "Nothing matches that." : "Your library is empty."}</p>}
          <ol className="zotero-items">
            {items?.map((it) => (
              <li key={it.key}>
                <div className="zotero-title">{it.title || "(untitled)"}</div>
                <div className="muted small">{[it.authors.length > 3 ? `${it.authors.slice(0, 3).join(", ")} et al.` : it.authors.join(", "), it.year, it.where].filter(Boolean).join(" · ")}</div>
                <div className="zotero-actions">
                  <button type="button" className="secondary" disabled={opening !== null} onClick={() => open(it)}>
                    {opening === it.key ? "Opening…" : "Open on a new canvas"}
                  </button>
                  {it.url && (
                    <a className="small" href={it.url} target="_blank" rel="noreferrer">
                      Source ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {more && (
            <button type="button" className="secondary" onClick={() => load(q, items?.length ?? 0)}>
              More
            </button>
          )}
        </>
      )}
    </main>
  );
}
