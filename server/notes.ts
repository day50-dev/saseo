// Notes: free-form words left on the canvas by the reader or the librarian. A note is read as it
// is, never explained; what it keeps is its context (who, when, about what, after what), so it can
// just sit there, or be looked into: its history is the canvas's own log up to the moment it was left.
import { type CardItem, type Item, type LoggedEvent, NOTE_WIDTH, type NoteHistory, type NoteItem, type NoteVia } from "../shared/canvas.ts";
import { actor, type CanvasStore, newId } from "./canvas.ts";

const clean = (t: unknown, max = 4000) => (typeof t === "string" ? t.replace(/\r/g, "").trim().slice(0, max) : "");

/** A short name for an item, as a person would say it. */
export function itemName(i: Item | undefined): string {
  if (!i) return "something since removed";
  if (i.kind === "card") return `“${short(i.subject ?? i.selection ?? i.request ?? i.origin?.title ?? "a card")}”`;
  if (i.kind === "image") return `“${short(i.video?.title ?? i.moment?.title ?? i.pdf?.title ?? i.source?.title ?? i.topic ?? i.name)}”`;
  if (i.kind === "note") return `the note “${short(i.text)}”`;
  return "a box on an image";
}

const short = (t: string, n = 70) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Where a note about `on` goes: to the right of it, below any note already there. */
async function placeFor(store: CanvasStore, on: Item | undefined): Promise<{ x: number; y: number }> {
  const { items } = await store.getState();
  if (!on || on.kind === "region") {
    const shown = items.filter((i): i is CardItem | NoteItem => (i.kind === "card" || i.kind === "note") && !i.hidden);
    const last = shown.at(-1);
    return last ? { x: last.x, y: last.y + (last.h ?? 300) + 40 } : { x: 0, y: 0 };
  }
  const x = on.x + on.w + 32;
  let y = on.y;
  for (const n of items) {
    if (n.kind !== "note" || n.hidden || n.on?.id !== on.id) continue;
    y = Math.max(y, n.y + (n.h ?? 120) + 16);
  }
  return { x, y };
}

export interface NewNote {
  text: string;
  by: "you" | "librarian";
  via: NoteVia;
  /** What it's about; a region's note is about the image. */
  on?: { id: string; key?: string; quote?: string };
  said?: string;
  x?: number;
  y?: number;
  w?: number;
}

export async function addNote(store: CanvasStore, n: NewNote): Promise<NoteItem | null> {
  const text = clean(n.text);
  if (!text) return null;
  const state = await store.getState();
  let target = n.on?.id ? state.items.find((i) => i.id === n.on!.id && !i.hidden) : undefined;
  if (target?.kind === "region") target = state.items.find((i) => i.id === (target as { imageId: string }).imageId);
  const at = Number.isFinite(n.x) && Number.isFinite(n.y) ? { x: Math.round(n.x!), y: Math.round(n.y!) } : await placeFor(store, target);
  const note: NoteItem = {
    kind: "note",
    id: newId(),
    text,
    by: n.by,
    ...(actor.getStore() ? { author: actor.getStore() } : {}),
    at: new Date().toISOString(),
    ...at,
    w: Math.round(Math.min(1200, Math.max(160, n.w ?? NOTE_WIDTH))),
    ...(target ? { on: { id: target.id, ...(n.on?.key ? { key: clean(n.on.key, 40) } : {}), ...(n.on?.quote ? { quote: clean(n.on.quote, 400) } : {}) } } : {}),
    context: { via: n.via, ...(n.said ? { said: clean(n.said, 1000) } : {}), seq: state.seq },
  };
  await store.add(note);
  return note;
}

/** Rewords a note, keeping what it said before. */
export async function editNote(store: CanvasStore, id: string, text: string, by: "you" | "librarian"): Promise<NoteItem | null> {
  const words = clean(text);
  if (!words) return null;
  await store.edit(id, (now) => {
    if (now?.kind !== "note" || now.text === words) return null;
    const was = { text: now.text, at: now.edited?.at ?? now.at, by: now.edited?.by ?? now.by };
    return { text: words, was: [...(now.was ?? []), was], edited: { at: new Date().toISOString(), by } };
  });
  const now = await store.findItem(id);
  return now?.kind === "note" ? now : null;
}


/** One line for an event, in the reader's terms; nothing for bookkeeping (moves, restacking). */
export function describeEvent(e: LoggedEvent, byId: Map<string, Item>): { what: string; id?: string } | null {
  const ev = e.event;
  switch (ev.type) {
    case "add": {
      const i = ev.item;
      if (i.kind === "region") return { what: `Drew a box on ${itemName(byId.get(i.imageId))}`, id: i.imageId };
      if (i.kind === "note") return { what: `${i.by === "you" ? "You" : "The librarian"} left a note: “${short(i.text, 120)}”`, id: i.id };
      if (i.kind === "image") {
        if (i.video) return { what: `Added the video ${itemName(i)}`, id: i.id };
        if (i.moment) return { what: `Stopped the video at ${Math.floor(i.moment.t / 60)}:${String(Math.floor(i.moment.t % 60)).padStart(2, "0")}`, id: i.id };
        return { what: `Added ${itemName(i)}`, id: i.id };
      }
      if (i.objectKind) return { what: `Asked for ${i.objectKind === "links" ? "reading" : i.objectKind}: ${short(i.request ?? "", 100)}`, id: i.id };
      if (i.origin) return { what: `Started from ${itemName(i)}`, id: i.id };
      if (i.relates) {
        const [x, y] = i.relates.map((r) => itemName(byId.get(r)));
        const asked = { relates: `how ${x} and ${y} relate`, differs: `how ${x} and ${y} differ`, disputes: `where ${x} and ${y} disagree`, leads: `whether ${x} or ${y} leads to the other`, within: `whether ${x} or ${y} is part of the other` }[i.relKind ?? "relates"];
        return { what: `Asked ${asked}`, id: i.id };
      }
      if (i.selection) return { what: `Asked what “${short(i.selection, 60)}” means, on ${itemName(byId.get(i.parentId))}`, id: i.id };
      return { what: `Opened ${itemName(i)}`, id: i.id };
    }
    case "chat":
      return ev.message.role === "user"
        ? { what: `Asked on ${itemName(byId.get(ev.id))}: “${short(ev.message.text, 120)}”`, id: ev.id }
        : { what: `The librarian answered: “${short(ev.message.text, 120)}”`, id: ev.id };
    case "update":
      if (ev.patch.text !== undefined) return { what: `The note was reworded: “${short(ev.patch.text, 120)}”`, id: ev.id };
      if (ev.patch.ext) {
        const x = ev.patch.ext.at(-1);
        return x && x.status === "working" ? { what: `Grew ${x.shape === "aside" ? "more" : `a “${x.shape}”`} on ${itemName(byId.get(ev.id))}${x.ask ? `: “${short(x.ask, 80)}”` : ""}`, id: ev.id } : null;
      }
      return null;
    case "hide":
      return { what: `Removed ${ev.ids.length === 1 ? itemName(byId.get(ev.ids[0])) : `${ev.ids.length} things`}` };
    case "show":
      return { what: `Brought back ${ev.ids.length === 1 ? itemName(byId.get(ev.ids[0])) : `${ev.ids.length} things`}` };
    case "goal":
      return { what: `Goal: “${short(ev.goal.text, 100)}”${ev.goal.status !== "open" ? ` (${ev.goal.status})` : ""}` };
    default:
      return null;
  }
}

/** A note's wordings, and the canvas's story around it: what led up to it, and what happened since. */
export async function noteHistory(store: CanvasStore, id: string, around = 12): Promise<NoteHistory | null> {
  const { items } = await store.getState();
  const note = items.find((i) => i.id === id);
  if (note?.kind !== "note") return null;
  const byId = new Map(items.map((i) => [i.id, i]));
  const log = await store.events();
  const versions = [...(note.was ?? []), { text: note.text, at: note.edited?.at ?? note.at, by: note.edited?.by ?? note.by }];
  const line = (e: LoggedEvent) => {
    const d = describeEvent(e, byId);
    return d ? { at: e.at, ...d } : null;
  };
  const before = log
    .filter((e) => e.seq <= note.context.seq)
    .map(line)
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .slice(-around);
  // Since: the note's own changes, and what happened to the thing it's about.
  const watch = new Set([id, ...(note.on ? [note.on.id] : [])]);
  const since = log
    .filter((e) => e.seq > note.context.seq && !(e.event.type === "add" && e.event.item.id === id))
    .filter((e) => {
      const ev = e.event;
      if (ev.type === "add") return ev.item.kind === "card" && watch.has(ev.item.parentId);
      if (ev.type === "hide" || ev.type === "show") return ev.ids.some((x) => watch.has(x));
      return (ev.type === "update" || ev.type === "chat") && watch.has(ev.id);
    })
    .map(line)
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .slice(-around);
  return { versions, before, since };
}
