// Video lectures (docs/BRAINSTORM.md, "Video lectures"): a YouTube video on the canvas, and the
// moments where it lost you. A moment is the frame at that instant, cut from the stream itself
// (sharp enough to read a board), plus what was said around it, from the captions.
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "./canvas.ts";

const run = promisify(execFile);
const DIR = path.join(DATA_DIR, "videos");
// YouTube needs a JavaScript runtime to hand out streams; node is the one we have.
const YTDLP = ["--js-runtimes", "node", "--no-warnings", "--no-playlist"];

export const YOUTUBE_ID = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

export function youtubeId(input: string): string | null {
  return input.match(YOUTUBE_ID)?.[1] ?? null;
}

export interface VideoInfo {
  videoId: string;
  title: string;
  channel: string;
  duration: number;
  description: string;
  /** The thumbnail, for where a still picture stands in for the video. */
  thumbnail: string;
}

export interface Caption {
  /** Seconds from the start. */
  t: number;
  text: string;
}

const ytUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

async function ytdlp(args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await run("yt-dlp", [...YTDLP, ...args], { timeout, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Title, channel, length and description, fetched once per video. */
export async function videoInfo(id: string): Promise<VideoInfo> {
  await mkdir(DIR, { recursive: true });
  const file = path.join(DIR, `${id}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as VideoInfo;
  } catch {}
  const j = JSON.parse(await ytdlp(["--skip-download", "--dump-json", ytUrl(id)])) as Record<string, unknown>;
  const info: VideoInfo = {
    videoId: id,
    title: String(j.title ?? ""),
    channel: String(j.channel ?? j.uploader ?? ""),
    duration: Number(j.duration ?? 0),
    description: String(j.description ?? "").slice(0, 3000),
    thumbnail: String(j.thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
  };
  await writeFile(file, JSON.stringify(info));
  return info;
}

/** The video's captions with times, human-written if there are any, else YouTube's automatic ones. */
export async function captions(id: string): Promise<Caption[]> {
  await mkdir(DIR, { recursive: true });
  const parsed = path.join(DIR, `${id}.captions.json`);
  try {
    return JSON.parse(await readFile(parsed, "utf8")) as Caption[];
  } catch {}
  // Exact English tracks only: patterns like "en.*" also match machine translations, which get refused.
  await ytdlp(
    ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en,en-US,en-GB,en-orig", "--sub-format", "json3", "-o", path.join(DIR, "%(id)s.%(ext)s"), ytUrl(id)],
  ).catch(() => "");
  const files = (await readdir(DIR)).filter((f) => f.startsWith(`${id}.`) && f.endsWith(".json3"));
  // Prefer a human track (plain "en") over the automatic original ("en-orig").
  files.sort((a, b) => Number(a.includes("orig")) - Number(b.includes("orig")));
  let out: Caption[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(await readFile(path.join(DIR, f), "utf8")) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
      out = (d.events ?? [])
        .filter((e) => e.segs?.length)
        .map((e) => ({ t: (e.tStartMs ?? 0) / 1000, text: e.segs!.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim() }))
        .filter((c) => c.text);
      if (out.length) break;
    } catch {}
  }
  await writeFile(parsed, JSON.stringify(out));
  return out;
}

/** What was said from `before` seconds before the moment to `after` seconds after it, with times. */
export function around(caps: Caption[], t: number, before = 60, after = 15): string {
  return caps
    .filter((c) => c.t >= t - before && c.t <= t + after)
    .map((c) => `[${clock(c.t)}]${c.t > t ? " (after)" : ""} ${c.text}`)
    .join("\n");
}

export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Stream URLs last a few hours; keep one for a while so each moment is a single seek.
interface Stream {
  url: string;
  w: number;
  h: number;
  /** Headers the stream must be fetched with (YouTube refuses some URLs without its client's). */
  headers: Record<string, string>;
  at: number;
}
const streams = new Map<string, Stream>();

async function stream(id: string): Promise<Stream> {
  const hit = streams.get(id);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit;
  // Video only is enough for a frame; 1080p keeps writing on a board readable.
  // H.264 first: every ffmpeg decodes it, unlike the AV1 YouTube often prefers.
  const out = await ytdlp(["-f", "bestvideo[height<=1080][vcodec^=avc1]/bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]/best[height<=1080]/best", "--print", "%(width)s %(height)s %(url)s", "--print", "%(http_headers)j", ytUrl(id)]);
  const lines = out.trim().split("\n");
  const [w, h, url] = (lines.find((l) => /^\S+ \S+ https?:/.test(l)) ?? "").split(" ");
  if (!url?.startsWith("http")) throw new Error("YouTube didn't give a stream for this video");
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}");
  } catch {}
  const s = { url, w: Number(w) || 1920, h: Number(h) || 1080, headers, at: Date.now() };
  streams.set(id, s);
  return s;
}

/** The frame at `t` seconds, as a JPEG, with its size. */
export async function frameAt(id: string, t: number): Promise<{ jpeg: Buffer; w: number; h: number }> {
  const grab = async () => {
    const s = await stream(id);
    const headers = Object.entries(s.headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const { stdout } = await run("ffmpeg", ["-loglevel", "error", ...(headers ? ["-headers", headers] : []), "-ss", String(Math.max(0, t)), "-i", s.url, "-frames:v", "1", "-q:v", "2", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], {
      timeout: 60_000,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (!stdout.length) throw new Error("no frame");
    return { jpeg: stdout, w: s.w, h: s.h };
  };
  try {
    return await grab();
  } catch {
    streams.delete(id); // the stream may have expired; get a fresh one and try once more
    return grab();
  }
}
