// A YouTube video on the canvas, playing in place, with a button to stop where it lost you.
// When the uploader doesn't allow embedding, it plays our own copy instead (fetched by the server).
import { useEffect, useRef, useState } from "react";
import type { CopyProgress, ImageItem } from "../shared/canvas.ts";
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
  // Not playable here yet: the uploader disallows embedding, the player refused, or the server is fetching a copy for either reason.
  const waiting = !own && (v.embeddable === false || blocked || (Boolean(v.why) && v.hosted !== undefined));

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
            <CopyStatus item={item} onRetry={onNeedCopy} />
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

const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

function duration(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Why the video isn't playing yet, and how the download of our copy is going. */
function CopyStatus({ item, onRetry }: { item: ImageItem; onRetry: () => void }) {
  const v = item.video!;
  const [p, setP] = useState<CopyProgress | null>(null);
  const failed = v.hosted === "failed";

  useEffect(() => {
    if (failed) return;
    let gone = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/video-progress/${v.videoId}`);
        if (r.ok && !gone) setP((await r.json()) as CopyProgress);
      } catch {}
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [v.videoId, failed]);

  const why =
    v.why === "player-refused"
      ? "YouTube refused to play this video on another site,"
      : "This video's owner doesn't allow it to be played on other sites,";
  const part = p?.phase === "sound" ? "the sound" : "the picture";
  let status: React.ReactNode;
  if (failed) {
    status = (
      <>
        The download failed{v.hostError ? `: ${v.hostError}` : "."}{" "}
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </>
    );
  } else if (!p || p.phase === "starting") status = "Starting the download…";
  else if (p.phase === "joining") status = "Putting the picture and sound together…";
  else if (p.phase === "ready") status = "Downloaded; starting it…";
  else if (p.phase === "failed") status = `The download failed${p.error ? `: ${p.error}` : "."}`;
  else
    status = [
      `Downloading ${part}`,
      p.percent !== undefined ? `${Math.floor(p.percent)}%` : "",
      p.bytes !== undefined && p.total ? `${mb(p.bytes)} of ${mb(p.total)}` : p.bytes !== undefined ? mb(p.bytes) : "",
      p.speed ? `${mb(p.speed)}/s` : "",
      p.eta !== undefined ? `about ${duration(p.eta)} left` : "",
    ]
      .filter(Boolean)
      .join(" · ");

  const showBar = !failed && p && (p.phase === "video" || p.phase === "sound") && p.percent !== undefined;
  return (
    <div className={`video-wait-note ${failed ? "failed" : ""}`}>
      <div className="video-wait-why">
        {why} so the librarian is downloading a copy to play here instead.
      </div>
      <div className="video-wait-status">
        {!failed && <span className="spinner" />} {status}
      </div>
      {showBar && (
        <div className="video-wait-bar" role="progressbar" aria-valuenow={Math.floor(p!.percent!)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${p!.percent}%` }} />
        </div>
      )}
    </div>
  );
}
