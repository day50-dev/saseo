// The YouTube IFrame Player API, loaded once, and the players on the canvas by item id, so a
// moment's ▶ can take its video back to where you stopped.

export interface YTPlayer {
  getCurrentTime(): number;
  pauseVideo(): void;
  playVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: { videoId: string; width?: string | number; height?: string | number; playerVars?: Record<string, unknown>; events?: Record<string, (e: { target: YTPlayer }) => void> },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let api: Promise<YTNamespace> | null = null;

export function youtubeApi(): Promise<YTNamespace> {
  api ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.append(s);
  });
  return api;
}

export const players = new Map<string, YTPlayer>();
