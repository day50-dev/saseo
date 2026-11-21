import { unreachable } from "./api.ts";
import type { CanvasState, CardItem, ImageItem, Rect, RegionItem } from "../shared/canvas.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const down = unreachable(res.status);
    if (down) throw new Error(down);
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const canvasApi = {
  state: () => fetch("/api/canvas").then((r) => json<CanvasState>(r)),

  addImage: (file: File, place: { x: number; y: number; w: number; h: number; naturalW: number; naturalH: number }) => {
    const form = new FormData();
    form.append("file", file);
    for (const [k, v] of Object.entries(place)) form.append(k, String(v));
    return fetch("/api/canvas/images", { method: "POST", body: form }).then((r) => json<ImageItem>(r));
  },

  addRegion: (body: { imageId: string; rect: Rect; card: { x: number; y: number }; marked: string; crop: string }) =>
    post("/api/canvas/regions", body).then((r) => json<{ region: RegionItem; card: CardItem }>(r)),

  /** Asks how two cards are related; the answer is a new card between them. */
  relate: (body: { a: string; b: string; x: number; y: number }) =>
    post("/api/canvas/relate", body).then((r) => json<{ card: CardItem }>(r)),

  descend: (body: { parentId: string; selection: string; context: string; x: number; y: number }) =>
    post("/api/canvas/descend", body).then((r) => json<{ card: CardItem }>(r)),

  /** Hides items and whatever depends on them; returns everything that was hidden. */
  hide: (ids: string[]) => post("/api/canvas/hide", { ids }).then((r) => json<{ ids: string[] }>(r)),

  collapse: (ids: string[], collapsed: boolean) =>
    post("/api/canvas/collapse", { ids, collapsed }).then((r) => json<{ ok: true }>(r)),

  move: (moves: { id: string; x: number; y: number; h?: number }[]) =>
    post("/api/canvas/move", { moves }).then((r) => json<{ ok: true }>(r)),

  retry: (cardId: string, images?: { marked: string; crop: string }) =>
    post(`/api/canvas/cards/${cardId}/retry`, images ?? {}).then((r) => json<{ ok: true }>(r)),

  show: (ids: string[]) => post("/api/canvas/show", { ids }).then((r) => json<{ ids: string[] }>(r)),
};

export const assetUrl = (name: string) => `/api/assets/${name}`;
