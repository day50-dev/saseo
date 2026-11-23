"""Cuts the explainer together: each scene's picture (a title card or a recorded clip) runs for
its narration plus a short breath either side, with soft fades; then all scenes are joined."""
import json
import os
import subprocess
import sys

DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT = "/home/chris/code/librarian/docs/explainer/script.json"
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DIR, "librarian-explainer.mp4")
LEAD, TAIL, FADE = 0.45, 0.65, 0.3


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip())


def run(args):
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr)


script = json.load(open(SCRIPT))
marks = json.load(open(os.path.join(DIR, "clips", "marks.json"))) if os.path.exists(os.path.join(DIR, "clips", "marks.json")) else {}
os.makedirs(os.path.join(DIR, "segments"), exist_ok=True)
segments = []
for sc in script["scenes"]:
    sid = sc["id"]
    wav = os.path.join(DIR, "audio", f"{sid}.wav")
    length = LEAD + duration(wav) + TAIL
    seg = os.path.join(DIR, "segments", f"{sid}.mp4")
    png = os.path.join(DIR, "shots", f"{sid}.png")
    clip = os.path.join(DIR, "clips", f"{sid}.webm")
    fades = f"fade=t=in:st=0:d={FADE},fade=t=out:st={length - FADE:.3f}:d={FADE}"
    audio = f"[1:a]adelay={int(LEAD * 1000)}:all=1,apad=whole_dur={length:.3f},aformat=sample_rates=48000:channel_layouts=stereo[a]"
    if os.path.exists(png):
        # A slow push in on a still card.
        frames = int(length * 30)
        video = (
            f"[0:v]scale=3840:-1,zoompan=z='min(1+0.00035*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s=1920x1080:fps=30,"
            f"format=yuv420p,{fades}[v]"
        )
        run(["-loop", "1", "-t", f"{length:.3f}", "-i", png, "-i", wav, "-filter_complex", f"{video};{audio}", "-map", "[v]", "-map", "[a]",
             "-t", f"{length:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", seg])
    elif os.path.exists(clip):
        start = marks.get(sid, 0)
        # From the shot's start; if the clip runs out, hold its last frame.
        video = (
            f"[0:v]trim=start={start:.3f},setpts=PTS-STARTPTS,fps=30,scale=1920:1080,"
            f"tpad=stop_mode=clone:stop_duration={length:.3f},trim=duration={length:.3f},format=yuv420p,{fades}[v]"
        )
        run(["-i", clip, "-i", wav, "-filter_complex", f"{video};{audio}", "-map", "[v]", "-map", "[a]",
             "-t", f"{length:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", seg])
    else:
        sys.exit(f"no picture for {sid}")
    segments.append(seg)
    print(sid, f"{length:.1f}s")

lst = os.path.join(DIR, "segments", "list.txt")
with open(lst, "w") as f:
    for s in segments:
        f.write(f"file '{s}'\n")
run(["-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", OUT])
print("wrote", OUT, f"{duration(OUT):.1f}s")
