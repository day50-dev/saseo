// A note on the canvas: words left as they are, by you or the librarian. It reads as a note, and
// carries its context (who, when, about what, after what): "History" opens what led up to it,
// its earlier wordings, and what has happened to it since.
import { useEffect, useRef, useState } from "react";
import type { NoteItem } from "../shared/canvas.ts";
import type { NoteHistory } from "./canvasApi.ts";
import { useMe } from "./session.ts";

const VIA = { canvas: "on the canvas", call: "on a call", chat: "in a card's conversation" } as const;

/** "3:12 pm", or "Nov 21, 3:12 pm" on another day. */
export function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

const who = (by: "you" | "librarian") => (by === "you" ? "You" : "Librarian");

export function Note(props: {
  note: NoteItem;
  /** What it's about, by name ("“Bialgebra”"), when it's about something. */
  aboutName?: string;
  z?: number;
  selected: boolean;
  lit: boolean;
  moving: boolean;
  /** A new note: opens in editing, and is dropped if left empty. */
  editing?: boolean;
  onGrab: (e: React.PointerEvent) => void;
  onHover: (on: boolean) => void;
  onHeight: (h: number) => void;
  onSave: (text: string) => Promise<void> | void;
  onCancel?: () => void;
  onRemove: () => void;
  onFocus: (id: string) => void;
  history: () => Promise<NoteHistory>;
}) {
  const { note } = props;
  const ref = useRef<HTMLDivElement>(null);
  // On a shared canvas, a note someone else left says who.
  const me = useMe().user?.id;
  const author = note.by === "librarian" ? "Librarian" : note.author && me && note.author.id !== me ? note.author.name : "You";
  const [editing, setEditing] = useState(Boolean(props.editing));
  const [text, setText] = useState(note.text);
  const [open, setOpen] = useState(false);
  const [hist, setHist] = useState<NoteHistory | null>(null);
  const [histError, setHistError] = useState<string | null>(null);

  const heightCb = useRef(props.onHeight);
  heightCb.current = props.onHeight;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => heightCb.current(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) setText(note.text);
  }, [note.text, editing]);

  // Reopened history follows the note as it changes.
  useEffect(() => {
    if (!open) return;
    let live = true;
    props.history().then(
      (h) => live && setHist(h),
      (e) => live && setHistError(String(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, note.text, note.hidden]);

  const finish = async () => {
    const words = text.trim();
    setEditing(false);
    if (!words) return props.editing ? props.onCancel?.() : setText(note.text);
    if (words !== note.text || props.editing) await props.onSave(words);
  };

  // Leaves editing without saving: a new note is dropped, an existing one keeps its words.
  const cancel = () => {
    if (props.editing) return props.onCancel?.();
    setText(note.text);
    setEditing(false);
  };

  const edits = note.was?.length ?? 0;
  return (
    <div
      ref={ref}
      data-note-id={note.id}
      className={`note-item by-${note.by} ${props.selected ? "selected" : ""} ${props.lit ? "lit" : ""} ${props.moving ? "moving" : ""}`}
      style={{ left: note.x, top: note.y, width: note.w, zIndex: props.moving ? 100000 : props.z }}
      onPointerEnter={() => props.onHover(true)}
      onPointerLeave={() => props.onHover(false)}
      onPointerDown={(e) => {
        // Its words are for reading, selecting and double-clicking to edit; the rest of it is the handle.
        if ((e.target as HTMLElement).closest("button, a, textarea, .note-text, .note-history")) return;
        if (editing) return;
        props.onGrab(e);
      }}
    >
      {editing ? (
        <>
        <textarea
          className="note-edit"
          // biome-ignore lint/a11y/noAutofocus: a note opens ready to type in.
          autoFocus
          value={text}
          rows={Math.min(14, Math.max(3, text.split("\n").length + 1))}
          placeholder="A note…"
          onChange={(e) => setText(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        {/* Pressing these doesn't count as leaving the box (which saves), so Cancel really cancels. */}
        <div className="note-actions">
          <button type="button" className="secondary" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
            Cancel
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void finish()} title="Save (Ctrl+Enter)">
            Save
          </button>
        </div>
        </>
      ) : (
        <div className="note-text" title="Double-click to edit" onDoubleClick={() => setEditing(true)}>
          {note.text}
        </div>
      )}
      {!props.editing && (
        <div className="note-meta">
          <span className="note-info">
            <span className="note-who">{author}</span>
            {" "}
            <span title={new Date(note.at).toLocaleString()}>{when(note.at)}</span>
            {note.on && props.aboutName && (
              <>
                {" "}
                <button type="button" className="note-about" title="Show what this note is about" onClick={() => props.onFocus(note.on!.id)}>
                  on {props.aboutName}
                </button>
              </>
            )}
            {edits > 0 && <span title={`Reworded ${edits} time${edits > 1 ? "s" : ""}`}> · edited</span>}
          </span>
          <button type="button" className="note-btn" aria-expanded={open} title="What led to this note, and what it said before" onClick={() => setOpen(!open)}>
            {open ? "Hide history" : "History"}
          </button>
          <button type="button" className="note-btn" title="Edit" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="note-btn" title="Remove this note (Undo brings it back)" onClick={props.onRemove}>
            ×
          </button>
        </div>
      )}
      {open && (
        <div className="note-history">
          <p className="note-context">
            {author === "You" ? "You left this" : author === "Librarian" ? "The librarian left this" : `${author} left this`} {VIA[note.context.via]}, {when(note.at)}
            {note.context.said ? (
              <>
                , after {note.context.via === "call" || note.context.via === "chat" ? "you said" : "the ask"} <q>{note.context.said}</q>
              </>
            ) : null}
            .
            {note.on?.quote ? (
              <>
                {" "}
                It's about <q>{note.on.quote.length > 200 ? `${note.on.quote.slice(0, 200)}…` : note.on.quote}</q>
                {props.aboutName ? <> on {props.aboutName}</> : null}.
              </>
            ) : null}
          </p>
          {histError && <p className="muted small">Couldn't load its history: {histError}</p>}
          {!hist && !histError && <p className="muted small">Loading…</p>}
          {hist && (
            <>
              {hist.versions.length > 1 && (
                <section>
                  <h4>Wordings</h4>
                  <ol className="note-versions">
                    {hist.versions.map((v, i) => (
                      <li key={`${v.at}-${i}`} className={i === hist.versions.length - 1 ? "now" : ""}>
                        <span className="muted small">
                          {who(v.by)}, {when(v.at)}
                        </span>
                        <div>{v.text}</div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <section>
                <h4>Before it</h4>
                {hist.before.length ? (
                  <ol className="note-trail">
                    {hist.before.map((b, i) => (
                      <li key={`${b.at}-${i}`}>
                        <span className="muted small">{when(b.at)}</span>{" "}
                        {b.id ? (
                          <button type="button" className="note-link" onClick={() => props.onFocus(b.id!)}>
                            {b.what}
                          </button>
                        ) : (
                          b.what
                        )}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted small">It was the first thing on the canvas.</p>
                )}
              </section>
              {hist.since.length > 0 && (
                <section>
                  <h4>Since</h4>
                  <ol className="note-trail">
                    {hist.since.map((b, i) => (
                      <li key={`${b.at}-${i}`}>
                        <span className="muted small">{when(b.at)}</span> {b.what}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
