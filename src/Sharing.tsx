// Sharing a canvas, and coming back to what others changed on it.
// - ShareDialog: the owner makes a link (to edit, or only to view), copies it, removes it, and sees
//   who has joined (and can take them off).
// - ChangesPanel: what other people did since you last looked, one line per thing, each with Show,
//   Undo (where there's a plain way back) and Keep. The same changes are marked on the canvas.
import { useState } from "react";
import type { Change, Member, ShareLink } from "../shared/canvas.ts";
import { when } from "./Note.tsx";

/** A colour per person, the same every time, for their changes on the canvas and in the list. */
const COLOURS = ["#d9480f", "#7048e8", "#0b7285", "#c2255c", "#2b8a3e", "#e67700"];
export function colourFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

const linkUrl = (token: string) => `${location.origin}/s/${token}`;

export function ShareDialog(props: {
  name: string;
  links: ShareLink[];
  members: Member[];
  onAddLink: (role: ShareLink["role"]) => Promise<void>;
  onRemoveLink: (token: string) => Promise<void>;
  onRemoveMember: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [role, setRole] = useState<ShareLink["role"]>("editor");
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(linkUrl(token));
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
    } catch {
      // No clipboard (an insecure page): the link is selectable in its box.
    }
  };
  return (
    <div className="panel-backdrop" onClick={props.onClose}>
      <div className="share-dialog" role="dialog" aria-label="Share this canvas" onClick={(e) => e.stopPropagation()}>
        <div className="share-head">
          <h2>Share “{props.name}”</h2>
          <button type="button" className="link" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="muted small">Anyone with a link can join. What they change is marked as theirs, and you'll see it when you come back.</p>
        <div className="share-new">
          <label>
            Anyone with the link can{" "}
            <select value={role} onChange={(e) => setRole(e.target.value as ShareLink["role"])}>
              <option value="editor">add and change things</option>
              <option value="viewer">only look</option>
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onAddLink(role);
              } finally {
                setBusy(false);
              }
            }}
          >
            Make a link
          </button>
        </div>
        {props.links.length > 0 && (
          <ul className="share-links">
            {props.links.map((l) => (
              <li key={l.token}>
                <span className="share-role">{l.role === "editor" ? "Can edit" : "Can view"}</span>
                <input readOnly value={linkUrl(l.token)} onFocus={(e) => e.target.select()} aria-label="Share link" />
                <button type="button" className="secondary" onClick={() => copy(l.token)}>
                  {copied === l.token ? "Copied ✓" : "Copy"}
                </button>
                <button type="button" className="link" title="Stop this link working (whoever joined with it stays)" onClick={() => props.onRemoveLink(l.token)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <h3>People</h3>
        {props.members.length === 0 ? (
          <p className="muted small">Nobody has joined yet.</p>
        ) : (
          <ul className="share-members">
            {props.members.map((m) => (
              <li key={m.id}>
                <span className="who-dot" style={{ background: colourFor(m.id) }} />
                <b>{m.name}</b> <span className="muted small">{m.role === "editor" ? "can edit" : "can view"} · joined {when(m.joinedAt)}</span>
                <button type="button" className="link" onClick={() => props.onRemoveMember(m.id)}>
                  Take off
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const VERB: Record<Change["what"], string> = {
  added: "added",
  removed: "removed",
  restored: "put back",
  moved: "moved",
  changed: "changed",
  goal: "changed",
};

/** "Ana", "Ana and Vic", "Ana, Vic and 2 others". */
export function names(changes: Change[]): string {
  const all = [...new Map(changes.map((c) => [c.by.id, c.by.name])).values()];
  if (all.length <= 2) return all.join(" and ");
  return `${all.slice(0, 2).join(", ")} and ${all.length - 2} other${all.length > 3 ? "s" : ""}`;
}

/** Whether a change has a plain way back. */
export const undoable = (c: Change) => c.what === "added" || c.what === "removed" || (c.what === "moved" && Boolean(c.before));

export function ChangesPanel(props: {
  changes: Change[];
  onShow: (c: Change) => void;
  onUndo: (c: Change) => Promise<void>;
  onKeep: (c: Change) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <aside className="changes-panel" aria-label="What changed while you were away">
      <div className="changes-head">
        <h2>Since you were here</h2>
        <button type="button" onClick={props.onDone}>
          Done
        </button>
      </div>
      {props.changes.length === 0 ? (
        <p className="muted small">You've been through everything.</p>
      ) : (
        <ul>
          {props.changes.map((c) => {
            const key = `${c.what}:${c.id}`;
            return (
              <li key={key} style={{ borderLeftColor: colourFor(c.by.id) }}>
                <div>
                  <b>{c.by.name}</b> {VERB[c.what]} <button type="button" className="link change-label" disabled={c.what === "removed" || c.what === "goal"} onClick={() => props.onShow(c)}>{c.label}</button>
                </div>
                <div className="change-actions">
                  <span className="muted small">{when(c.at)}</span>
                  {undoable(c) && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === key}
                      title={c.what === "added" ? "Remove it (it can be brought back)" : c.what === "removed" ? "Put it back" : "Put it back where it was"}
                      onClick={async () => {
                        setBusy(key);
                        try {
                          await props.onUndo(c);
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Undo
                    </button>
                  )}
                  <button type="button" className="secondary" onClick={() => props.onKeep(c)}>
                    Keep
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
