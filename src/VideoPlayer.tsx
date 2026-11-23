// A YouTube video on the canvas, playing in place, with a button to stop where it lost you.
// When the uploader doesn't allow embedding, it plays our own copy instead (fetched by the server).
import { useEffect, useRef, useState } from "react";
import type { ImageItem } from "../shared/canvas.ts";
import { assetUrl } from "./canvasApi.ts";
import { players, type YTPlayer, youtubeApi } from "./youtube.ts";

export const STOP_BAR = 52; // world pixels under the video taken by its Stop bar

// The IFrame API's errors for "the owner doesn't allow playing this on other sites".
const NOT_EMBEDDABLE = new Set([101, 150, 152, 153]);

export function VideoPlayer({
  item,
  z,
  selected,
  onStop,
  onNeedCopy,
}: {
  item: ImageItem;
  z: number | undefined;
  selected: boolean;
  /** Stop at this many seconds in: capture the moment. */
  onStop: (t: number) => Promise<void>;
  /** YouTube won't play it here: ask the server for our own copy. */
  onNeedCopy: () => void;
}) {
  const v = item.video!;
  const [blocked, setBlocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const own = v.hosted === "ready";
  const waiting = !own && (v.embeddable === false || blocked);

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
      <div className="video-frame" style={{ height: item.h }}>
        {own ? (
          <OwnCopy item={item} onReady={() => setReady(true)} />
        ) : waiting ? (
          <div className="video-wait" style={{ backgroundImage: item.asset ? `url(${assetUrl(item.asset)})` : undefined }}>
            <div className="video-wait-note">
              {v.hosted === "failed" ? (
                <>
                  Couldn't fetch a copy of this video.{" "}
                  <button type="button" onClick={onNeedCopy}>
                    Try again
                  </button>
                </>
              ) : (
                <>
                  <span className="spinner" /> This video can't be played on other sites, so the librarian is fetching a copy to play here…
                </>
              )}
            </div>
          </div>
        ) : (
          <YouTubeEmbed
            item={item}
            onReady={() => setReady(true)}
            onBlocked={() => {
              setBlocked(true);
              setReady(false);
              onNeedCopy();
            }}
          />
        )}
      </div>
      <div className="video-bar" style={{ height: STOP_BAR }}>
        <button type="button" className="video-stop" disabled={!ready || busy || waiting} onClick={stop} title="Pause here and put this moment on the canvas: the frame, and what was said around it">
          {busy ? "Grabbing this moment…" : "⏸ Stop here and ask"}
        </button>
        <span className="muted small">{own ? "Playing the librarian's copy. " : ""}Then box anything in the frame, or select words from what was said.</span>
      </div>
    </div>
  );
}

function YouTubeEmbed({ item, onReady, onBlocked }: { item: ImageItem; onReady: () => void; onBlocked: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onReady, onBlocked });
  cb.current = { onReady, onBlocked };
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
        events: {
          onReady: () => cb.current.onReady(),
          onError: (e) => {
            if (NOT_EMBEDDABLE.has(e.data ?? 0)) cb.current.onBlocked();
          },
        },
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

  return <div className="video-host" ref={host} />;
}

/** Our own copy, in a plain video element, driven through the same calls as YouTube's player. */
function OwnCopy({ item, onReady }: { item: ImageItem; onReady: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p: YTPlayer = {
      getCurrentTime: () => el.currentTime,
      pauseVideo: () => el.pause(),
      playVideo: () => void el.play().catch(() => {}),
      seekTo: (s) => {
        el.currentTime = s;
      },
      getPlayerState: () => (el.paused ? 2 : 1),
      destroy: () => {},
    };
    players.set(item.id, p);
    return () => {
      players.delete(item.id);
    };
  }, [item.id]);
  return <video ref={ref} className="video-own" src={`/api/videos/${item.video!.videoId}.mp4`} controls preload="metadata" onLoadedMetadata={onReady} />;
}
