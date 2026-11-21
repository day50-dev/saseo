import type { CanvasState, CardItem, ImageItem, Rect, RegionItem } from "../shared/canvas.ts";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
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

  descend: (body: { parentId: string; selection: string; x: number; y: number }) =>
    post("/api/canvas/descend", body).then((r) => json<{ card: CardItem }>(r)),
};

export const assetUrl = (name: string) => `/api/assets/${name}`;
