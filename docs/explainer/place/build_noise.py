"""The noise: real feeds (YouTube Shorts, Instagram Reels, a page of YouTube clickbait), cut faster
and faster under the narration, to a hard cut into the next scene."""
import json, os, subprocess
D = os.path.dirname(os.path.abspath(__file__))
sec = lambda f: float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout)
LEAD = 0.45
hold = next(s["hold"] for s in json.load(open(f"{D}/script-v4.json"))["scenes"] if s["id"] == "d1-noise")
L = LEAD + sec(f"{D}/audio/d1-noise.wav") + 0.65 + hold
calm = L
R = f"{D}/real"
# Where the vertical video sits in each desktop recording, and the stretch of it worth using.
SRC = {
  "shorts": (f"{R}/yt-shorts.webm", (754, 64, 556, 980), 5.0, 25.0),
  "insta": (f"{R}/insta.webm", (682, 72, 554, 986), 6.0, 10.6),
  "search": (f"{R}/yt-search.webm", None, 5.5, 20.0),
}
BG = "0x0b0b0d"
def vert(name, t, d, out_w, out_h):
    f, (x, y, w, h), a, b = SRC[name]
    return ["-ss", f"{t:.2f}", "-t", f"{d:.2f}", "-i", f], f"crop={w}:{h}:{x}:{y},scale=-2:{out_h},pad={out_w}:{out_h}:(ow-iw)/2:0:{BG},setsar=1"
segs = []
t, k = 0.0, 0
pos = {"shorts": 5.0, "insta": 6.0, "search": 5.5}
pattern = ["shorts", "search", "insta", "tri", "shorts", "search", "tri", "insta", "shorts", "tri", "search", "insta", "tri"]
os.makedirs(f"{D}/noise", exist_ok=True)
while t < calm - 0.05:
    frac = t / calm
    d = min(max(0.32, 1.25 - 1.0 * frac), calm - t)
    kind = pattern[k % len(pattern)]
    out = f"{D}/noise/{k:02d}.mp4"
    if kind == "search":
        f, _, a, b = SRC["search"]
        ins, flt = ["-ss", f"{pos['search']:.2f}", "-t", f"{d:.2f}", "-i", f], "[0:v]scale=1920:1080,setsar=1[o]"
        pos["search"] = a + ((pos["search"] - a + d * 1.6) % (b - a))
    elif kind == "tri":
        ins, parts = [], []
        for i, n in enumerate(["shorts", "insta", "shorts"]):
            st = pos[n] + (4.0 if i == 2 else 0)
            f, box, a, b = SRC[n]
            st = a + ((st - a) % (b - a - d))
            i2, fl = vert(n, st, d, 620, 1080)
            ins += i2
            parts.append(f"[{i}:v]{fl}[p{i}]")
        flt = ";".join(parts) + f";[p0][p1][p2]hstack=inputs=3,pad=1920:1080:30:0:{BG}[o]"
    else:
        f, box, a, b = SRC[kind]
        ins, fl = vert(kind, pos[kind], d, 1920, 1080)
        # Enlarged: the video fills the height, on dark.
        flt = f"[0:v]{fl}[o]"
        pos[kind] = a + ((pos[kind] - a + d * 1.8) % (b - a - 1))
    subprocess.run(["ffmpeg","-y","-loglevel","error",*ins,"-filter_complex",flt,"-map","[o]","-r","30","-t",f"{d:.3f}","-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",out],check=True)
    segs.append(out)
    t += d
    k += 1
with open(f"{D}/noise/list.txt","w") as fh:
    for s in segs: fh.write(f"file '{s}'\n")
subprocess.run(["ffmpeg","-y","-loglevel","error","-f","concat","-safe","0","-i",f"{D}/noise/list.txt","-c:v","libvpx-vp9","-crf","20","-b:v","0","-deadline","realtime","-cpu-used","8",f"{D}/clips/d1-noise.webm"],check=True)
m = json.load(open(f"{D}/clips/marks.json")); m["d1-noise"] = 0; json.dump(m, open(f"{D}/clips/marks.json","w"), indent=2)
print(f"noise: {k} cuts, {L:.2f}s")
