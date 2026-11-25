import json, os, subprocess
D = os.path.dirname(os.path.abspath(__file__))
R = f"{D}/v3raw"
def dur(p): return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p],capture_output=True,text=True).stdout)
def join(parts, out):
    # parts: list of (file or None for silence, seconds of silence)
    inputs, filt = [], []
    for i,(f,s) in enumerate(parts):
        if f: inputs += ["-i", f]
        else: inputs += ["-f","lavfi","-t",f"{s:.3f}","-i","anullsrc=r=48000:cl=mono"]
        filt.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=mono[s{i}]")
    filt.append("".join(f"[s{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=0:a=1[o]")
    subprocess.run(["ffmpeg","-y","-loglevel","error",*inputs,"-filter_complex",";".join(filt),"-map","[o]",out],check=True)
os.makedirs(f"{D}/audio", exist_ok=True)
for scene in ["d0-promise","d1-noise","d2-explore","d4-space","d5-close"]:
    lines = sorted(f for f in os.listdir(R) if f.startswith(scene+"__"))
    parts = []
    for i,f in enumerate(lines):
        if i: parts.append((None, 0.9 if scene=="d0-promise" else 0.45))
        parts.append((f"{R}/{f}",0))
    join(parts, f"{D}/audio/{scene}.wav")
    print(scene, round(dur(f"{D}/audio/{scene}.wav"),2))
# The call: the button, then each question, a beat, the answer, and time to see what it made.
plan = [("lead",1.6),("q1",0),("gap",0.6),("a1",0),("gap",2.6),("q2",0),("gap",0.6),("a2",0),("gap",5.0),("q3",0),("gap",0.6),("a3",0),("gap",6.0)]
parts, sched, t = [], {}, 0.0
for k,s in plan:
    if k in ("lead","gap"):
        parts.append((None,s)); t += s
    else:
        d = dur(f"{R}/{k}.wav"); parts.append((f"{R}/{k}.wav",0)); sched[k] = {"start": round(t,2), "end": round(t+d,2)}; t += d
join(parts, f"{D}/audio/d3-call.wav")
json.dump(sched, open(f"{D}/call4-schedule.json","w"), indent=1)
print("d3-call", round(t,2), sched)
# The end card: a short silence.
join([(None,3.0)], f"{D}/audio/d6-end.wav")
