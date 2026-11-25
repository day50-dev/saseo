"""Rebuilds a recorded clip on the page's own clock: each frame carries a time stamp (a strip of
squares under the picture, see op.html); every output frame at 30 fps shows the last recorded frame
stamped at or before its time. The strip is cropped off. Usage: retime.py in.webm out.webm seconds"""
import os, shutil, subprocess, sys
src, out, length = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]), float(sys.argv[3])
W, H, CELL, N = 1920, 1080, 24, 17
raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", src, "-vf", f"crop={CELL*N}:30:0:{H},scale={N}:1:flags=area", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
stamps = []
for k in range(len(raw) // N):
    px = raw[k * N:(k + 1) * N]
    if px[0] < 128:
        stamps.append(None)
        continue
    v = 0
    for b in px[1:]:
        v = (v << 1) | (1 if b >= 128 else 0)
    stamps.append(v / 100)
frames = os.path.join(os.path.dirname(out), "retime-frames")
shutil.rmtree(frames, ignore_errors=True)
os.makedirs(frames)
subprocess.run(["ffmpeg", "-loglevel", "error", "-i", src, "-vf", f"crop={W}:{H}:0:0", "-q:v", "2", os.path.join(frames, "%05d.jpg")], check=True)
n = len(os.listdir(frames))
# A blank page before loading reads as all white: a stamp past the end is no stamp.
good = [(t, k) for k, t in enumerate(stamps[:n]) if t is not None and t <= length + 5]
# Stamps only ever go up; a misread one that jumps backwards is dropped.
clean, last = [], -1
for t, k in good:
    if t >= last:
        clean.append((t, k))
        last = t
print(f"retime: {len(clean)} stamped frames of {n}, page clock {clean[0][0]:.2f}–{clean[-1][0]:.2f} s")
lst = os.path.join(frames, "list.txt")
j = 0
with open(lst, "w") as f:
    for i in range(int(length * 30)):
        t = i / 30
        while j + 1 < len(clean) and clean[j + 1][0] <= t:
            j += 1
        f.write(f"file '{os.path.join(frames, f'{clean[j][1] + 1:05d}.jpg')}'\nduration {1/30:.6f}\n")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-r", "30", "-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-row-mt", "1", "-deadline", "realtime", "-cpu-used", "8", out], check=True)
shutil.rmtree(frames)
print("retimed", out)
