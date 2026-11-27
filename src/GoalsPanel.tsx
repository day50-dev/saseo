// What you're after, as a tree: your goals, what they turned out to need (subgoals) and where
// curiosity wandered (detours). The librarian places each new card under one as it finishes; you
// can add your own, reword one (what it was is kept), finish it, clear it, or move it. Clicking a
// goal walks through its cards on the canvas; hovering lights them up.
import { useState } from "react";
import type { CardItem, Goal } from "../shared/canvas.ts";
import { cardsToReExplain } from "../shared/goals.ts";

const MARK: Record<Goal["kind"], string> = { goal: "◎", subgoal: "↳", detour: "⤳" };
const KIND: Record<Goal["kind"], string> = { goal: "Goal", subgoal: "Needed for the goal above", detour: "A side trip" };

export function GoalsPanel({
  goals,
  cards,
  current,
  onAdd,
  onChange,
  onReExplain,
  onFocus,
  onLight,
  onClose,
}: {
  goals: Goal[];
  cards: Map<string, CardItem>;
  /** The goal you're in now: the selected card's, or the newest card's. */
  current?: string;
  onAdd: (text: string, parentId?: string) => void;
  onChange: (goal: Goal, change: Partial<Goal>) => void;
  /** Write the cards it's now the lens for again, through it. */
  onReExplain: (goal: Goal) => void;
  onFocus: (cardId: string) => void;
  /** Light these cards up on the canvas (none: stop). */
  onLight: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState<string | null>(null); // "" for a goal of its own, or a parent id
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [showCleared, setShowCleared] = useState(false);
  const [walk, setWalk] = useState<Record<string, number>>({});

  const live = (g: Goal) => g.cards.filter((id) => cards.has(id));
  const kids = (id?: string) =>
    goals.filter((g) => (id ? g.parentId === id : !g.parentId || !goals.some((p) => p.id === g.parentId))).filter((g) => showCleared || g.status !== "dropped");
  const cleared = goals.filter((g) => g.status === "dropped").length;
  // The path from the root down to where you are.
  const path = new Set<string>();
  for (let g = goals.find((x) => x.id === current); g; g = goals.find((x) => x.id === g!.parentId)) path.add(g.id);

  const step = (g: Goal) => {
    const ids = live(g);
    if (!ids.length) return;
    const i = (walk[g.id] ?? -1) + 1;
    setWalk({ ...walk, [g.id]: i % ids.length });
    onFocus(ids[i % ids.length]);
  };

  const addBox = (parentId: string) => (
    <form
      className="goal-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) onAdd(draft.trim(), parentId || undefined);
        setDraft("");
        setAdding(null);
      }}
    >
      <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={parentId ? "What does it need?" : "What are you after?"} onKeyDown={(e) => e.key === "Escape" && setAdding(null)} />
    </form>
  );

  const row = (g: Goal, depth: number): React.ReactNode => {
    const ids = live(g);
    const here = g.id === current;
    return (
      <li key={g.id}>
        <div
          className={`goal-row ${g.kind} ${g.status} ${here ? "here" : path.has(g.id) ? "on-path" : ""}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onMouseEnter={() => onLight(ids)}
          onMouseLeave={() => onLight([])}
        >
          <span className="goal-mark" title={KIND[g.kind]}>
            {MARK[g.kind]}
          </span>
          {editing === g.id ? (
            <form
              className="goal-edit"
              onSubmit={(e) => {
                e.preventDefault();
                const t = new FormData(e.currentTarget).get("t");
                if (typeof t === "string" && t.trim() && t.trim() !== g.text) onChange(g, { text: t.trim() });
                setEditing(null);
              }}
            >
              <input name="t" autoFocus defaultValue={g.text} onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
            </form>
          ) : (
            <button type="button" className="goal-text" title={ids.length ? "Show its cards, one after another" : "No cards yet"} onClick={() => step(g)} onDoubleClick={() => setEditing(g.id)}>
              <span className="goal-words">{g.text}</span>
              <span className="goal-meta">
                {here && <span className="goal-here">you're here</span>}
                <span className="goal-count">
                  {ids.length ? `${walk[g.id] !== undefined ? `${walk[g.id] + 1} of ` : ""}${ids.length} card${ids.length > 1 ? "s" : ""}` : "no cards"}
                </span>
                {g.by === "librarian" && g.status === "open" && (
                  <span className="goal-guess" title="The librarian's guess: reword it if it's wrong">
                    guess
                  </span>
                )}
              </span>
            </button>
          )}
          <span className="goal-tools">
            <button type="button" title="Reword it (what it was is kept)" onClick={() => setEditing(g.id)}>
              ✎
            </button>
            <button type="button" title="Add something it needs" onClick={() => (setAdding(g.id), setDraft(""))}>
              +
            </button>
            {g.status === "open" ? (
              <>
                <button type="button" title="Got it: done" onClick={() => onChange(g, { status: "done" })}>
                  ✓
                </button>
                <button type="button" title="Clear it: not after this any more" onClick={() => onChange(g, { status: "dropped" })}>
                  ✕
                </button>
              </>
            ) : (
              <button type="button" title="Open it again" onClick={() => onChange(g, { status: "open" })}>
                ↺
              </button>
            )}
            {g.parentId && (
              <button type="button" title="Make it a goal of its own" onClick={() => onChange(g, { parentId: undefined })}>
                ⇱
              </button>
            )}
          </span>
        </div>
        {g.was?.length ? (
          <div className="goal-was" style={{ paddingLeft: 30 + depth * 16 }}>
            was: {g.was.map((w, i) => (
              <s key={i}>{w}</s>
            ))}
          </div>
        ) : null}
        {g.by === "you" && g.status === "open" && (() => {
          // Cards written before this goal (or before it was worded this way) read as they did.
          const stale = cardsToReExplain(g, goals, [...cards.values()]);
          return stale.length ? (
            <div className="goal-lens" style={{ paddingLeft: 30 + depth * 16 }}>
              <button
                type="button"
                className="link small"
                title="Write them again with this goal in mind, from the sources they found. What you grew from them is set aside with the old words; undo brings both back."
                onMouseEnter={() => onLight(stale.map((c) => c.id))}
                onMouseLeave={() => onLight([])}
                onClick={() => onReExplain(g)}
              >
                ↻ Re-explain {stale.length === 1 ? "1 card" : `${stale.length} cards`} for this goal
              </button>
            </div>
          ) : null;
        })()}
        {adding === g.id && <div style={{ paddingLeft: 24 + depth * 16 }}>{addBox(g.id)}</div>}
        <ul>{kids(g.id).map((k) => row(k, depth + 1))}</ul>
      </li>
    );
  };

  const roots = kids();
  return (
    <aside className="goals-panel" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <strong>Goals</strong>
        <span className="muted small">what you're after, and what it took</span>
        <button type="button" className="link" onClick={onClose} title="Close">
          ✕
        </button>
      </header>
      <ul className="goal-tree">{roots.map((g) => row(g, 0))}</ul>
      {!goals.length && <p className="muted small goal-empty">None yet. The first thing you look into starts one, or say what you're after:</p>}
      {adding === "" ? (
        addBox("")
      ) : (
        <button type="button" className="secondary goal-new" onClick={() => (setAdding(""), setDraft(""))}>
          + A goal of your own
        </button>
      )}
      {cleared > 0 && (
        <button type="button" className="link small goal-cleared" onClick={() => setShowCleared(!showCleared)}>
          {showCleared ? "Hide" : "Show"} cleared ({cleared})
        </button>
      )}
      <p className="muted small goal-legend">◎ a goal · ↳ needed for the one above · ⤳ a side trip. Click one to walk through its cards; double-click to reword.</p>
    </aside>
  );
}
