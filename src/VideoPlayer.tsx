// A YouTube video on the canvas, playing in place, with a button to stop where it lost you.
import { useEffect, useRef, useState } from "react";
import type { ImageItem } from "../shared/canvas.ts";
import { players, youtubeApi } from "./youtube.ts";

export const STOP_BAR = 52; // world pixels under the video taken by its Stop bar

export function VideoPlayer({
  item,
  z,
  selected,
  onStop,
}: {
  item: ImageItem;
  z: number | undefined;
  selected: boolean;
  /** Stop at this many seconds in: capture the moment. */
  onStop: (t: number) => Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const videoId = item.video!.videoId;

  useEffect(() => {
    let gone = false;
    const el = document.createElement("div");
    host.current?.append(el);
    youtubeApi().then((YT) => {
      if (gone) return;
      const p = new YT.Player(el, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
        events: { onReady: () => setReady(true) },
      });
      players.set(item.id, p);
    });
    return () => {
      gone = true;
      players.get(item.id)?.destroy();
      players.delete(item.id);
      el.remove();
    };
  }, [videoId, item.id]);

  const stop = async () => {
    const p = players.get(item.id);
    if (!p || busy) return;
    p.pauseVideo();
    setBusy(true);
    try {
      await onStop(p.getCurrentTime());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`video-item ${selected ? "selected" : ""}`}
      style={{ left: item.x, top: item.y, width: item.w, zIndex: z, display: item.collapsed ? "none" : undefined }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="video-frame" ref={host} style={{ height: item.h }} />
      <div className="video-bar" style={{ height: STOP_BAR }}>
        <button type="button" className="video-stop" disabled={!ready || busy} onClick={stop} title="Pause here and put this moment on the canvas: the frame, and what was said around it">
          {busy ? "Grabbing this moment…" : "⏸ Stop here and ask"}
        </button>
        <span className="muted small">Then box anything in the frame, or select words from what was said.</span>
      </div>
    </div>
  );
}
