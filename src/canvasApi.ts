import { unreachable } from "./api.ts";
import type { CanvasInfo, CanvasState, CanvasSummary, CardItem, Extension, ImageItem, ImageSource, Rect, RegionItem } from "../shared/canvas.ts";

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) location.reload();
  if (!res.ok) {
    const down = unreachable(res.status);
    if (down) throw new Error(down);
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, path: string, body: unknown) =>
  fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = (path: string, body: unknown) => send("POST", path, body);

/** The list of canvases, and making or renaming one. */
export const canvasesApi = {
  /** Every canvas you can open, trashed ones included, most recently changed first. */
  list: () => fetch("/api/canvases").then((r) => json<CanvasSummary[]>(r)),
  create: (name: string) => post("/api/canvases", { name }).then((r) => json<CanvasInfo>(r)),
  rename: (id: string, name: string) => send("PATCH", `/api/canvases/${id}`, { name }).then((r) => json<CanvasInfo>(r)),
  /** Moves a canvas into or out of the trash; nothing in it is deleted. */
  trash: (id: string, trashed: boolean) => send("PATCH", `/api/canvases/${id}`, { trashed }).then((r) => json<CanvasInfo>(r)),
  duplicate: (id: string) => post(`/api/canvases/${id}/duplicate`, {}).then((r) => json<CanvasInfo>(r)),
};

export class CanvasNotFound extends Error {}

/** Everything on one canvas. */
export function canvasApi(cid: string) {
  const base = `/api/canvases/${encodeURIComponent(cid)}`;
  return {
    state: () =>
      fetch(base).then((r) => {
        if (r.status === 404) throw new CanvasNotFound(cid);
        return json<CanvasState & CanvasInfo>(r);
      }),

    addImage: (
      file: File,
      place: { x: number; y: number; w: number; h: number; naturalW: number; naturalH: number },
      source?: ImageSource,
    ) => {
      const form = new FormData();
      form.append("file", file);
      for (const [k, v] of Object.entries(place)) form.append(k, String(v));
      if (source) form.append("source", JSON.stringify(source));
      return fetch(`${base}/images`, { method: "POST", body: form }).then((r) => json<ImageItem>(r));
    },

    addRegion: (body: { imageId: string; rect: Rect; card: { x: number; y: number }; marked: string; crop: string }) =>
      post(`${base}/regions`, body).then((r) => json<{ region: RegionItem; card: CardItem }>(r)),

    /** Starts from a link (the page is read) or a statement (explained beside it). */
    addSource: (input: string, x: number, y: number) =>
      post(`${base}/sources`, { input, x, y }).then((r) => json<{ card?: CardItem; answer?: CardItem; image?: ImageItem }>(r)),

    /** Asks the server to fetch its own copy of a video that can't be embedded. */
    hostVideo: (videoId: string) => post(`${base}/videos/${videoId}/host`, {}).then((r) => json<{ ok: true }>(r)),

    /** Stops a video at `t` seconds: the frame and what was said around it land at x, y. */
    moment: (videoId: string, t: number, x: number, y: number) =>
      post(`${base}/videos/${videoId}/moments`, { t, x, y }).then((r) => json<{ image: ImageItem; card?: CardItem }>(r)),

    /** Asks how two cards are related; the answer is a new card between them. */
    relate: (body: { a: string; b: string; x: number; y: number }) =>
      post(`${base}/relate`, body).then((r) => json<{ card: CardItem }>(r)),

    descend: (body: { parentId: string; selection: string; context: string; x: number; y: number }) =>
      post(`${base}/descend`, body).then((r) => json<{ card: CardItem }>(r)),

    /** Hides items and whatever depends on them; returns everything that was hidden. */
    hide: (ids: string[]) => post(`${base}/hide`, { ids }).then((r) => json<{ ids: string[] }>(r)),

    collapse: (ids: string[], collapsed: boolean) =>
      post(`${base}/collapse`, { ids, collapsed }).then((r) => json<{ ok: true }>(r)),

    move: (moves: { id: string; x: number; y: number; h?: number }[]) =>
      post(`${base}/move`, { moves }).then((r) => json<{ ok: true }>(r)),

    /** Answers the librarian's question on a card; "" skips it. */
    /** Grows a shape from a piece of a card's diagram. */
    extend: (cardId: string, body: { at: string; shape?: string; ask?: string; focus?: string }) =>
      post(`${base}/cards/${cardId}/extend`, body).then((r) => json<{ ext: Extension }>(r)),
    unextend: (cardId: string, extId: string) => post(`${base}/cards/${cardId}/extend/${extId}/remove`, {}).then((r) => json<{ removed: string[] }>(r)),
    courses: (cardId: string) => post(`${base}/cards/${cardId}/courses`, {}).then((r) => json<{ ok: true }>(r)),
    look: (cardId: string) => post(`${base}/cards/${cardId}/look`, {}).then((r) => json<{ ok: true }>(r)),
    answer: (cardId: string, answer: string) => post(`${base}/cards/${cardId}/answer`, { answer }).then((r) => json<{ ok: true }>(r)),
    retry: (cardId: string, images?: { marked: string; crop: string }) =>
      post(`${base}/cards/${cardId}/retry`, images ?? {}).then((r) => json<{ ok: true }>(r)),

    /** Adds a message to a card's conversation; the answer arrives in the canvas state. */
    chat: (cardId: string, text: string) => post(`${base}/cards/${cardId}/chat`, { text }).then((r) => json<{ ok: true }>(r)),

    /** Sets stacking order: higher z draws on top. */
    restack: (order: { id: string; z: number }[]) => post(`${base}/z`, { order }).then((r) => json<{ ok: true }>(r)),

    show: (ids: string[]) => post(`${base}/show`, { ids }).then((r) => json<{ ids: string[] }>(r)),
  };
}

export const assetUrl = (name: string) => `/api/assets/${name}`;
