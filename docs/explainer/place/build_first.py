"""The opening: 1994 web footage (DEC, "Glimpse of the Future", from 0:43) with its own narrator
for six seconds, who then fades under ours: "The web was supposed to be...". Builds the scene's
picture (clips/d0-promise.webm, pillarboxed) and sound (audio/d0-promise.wav)."""
import json, os, subprocess
D = os.path.dirname(os.path.abspath(__file__))
SRC, AT, OWN = f"{D}/first/src.mp4", 43.0, 6.0  # where it starts, and how long it speaks alone (to "...easy-to-use form.")
LEAD, TAIL = 0.45, 0.65
sec = lambda f: float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f],capture_output=True,text=True).stdout)
R = f"{D}/v4fast"
n0, n1 = sec(f"{R}/d0-promise__00.wav"), sec(f"{R}/d0-promise__01.wav")
ours = OWN + 0.1  # our narrator comes in as theirs fades
total = ours + n0 + 0.6 + n1
run = lambda a: subprocess.run(["ffmpeg","-y","-loglevel","error",*a],check=True)
# Sound: theirs at full for OWN seconds, then down under ours and gone; ours over it.
run(["-ss", f"{AT}", "-t", f"{total:.3f}", "-i", SRC, "-i", f"{R}/d0-promise__00.wav", "-i", f"{R}/d0-promise__01.wav",
     "-filter_complex",
     f"[0:a]aresample=48000,aformat=channel_layouts=mono,volume='if(lt(t,{OWN}),1,max(0,1-(t-{OWN})/0.7)*0.25+if(lt(t,{OWN}+0.35),0.75*(1-(t-{OWN})/0.35),0))':eval=frame[a0];"
     f"[1:a]aresample=48000,aformat=channel_layouts=mono,adelay={int(ours*1000)}:all=1[a1];"
     f"[2:a]aresample=48000,aformat=channel_layouts=mono,adelay={int((ours+n0+0.6)*1000)}:all=1[a2];"
     f"[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0[o]", "-map", "[o]", "-t", f"{total:.3f}", f"{D}/audio/d0-promise.wav"])
# Picture: from LEAD before the sound starts (the scene's sound is delayed by LEAD), long enough
# for the whole scene, scaled up to full height on black.
script = json.load(open(os.environ.get("SCRIPT", f"{D}/script-v4.json")))["scenes"]
hold = next(s.get("hold", 0) for s in script if s["id"] == "d0-promise")
length = LEAD + total + TAIL + hold
run(["-ss", f"{AT - LEAD:.3f}", "-t", f"{length + 0.5:.3f}", "-i", SRC, "-an",
     "-vf", "scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:black,setsar=1,fps=30",
     "-c:v", "libvpx-vp9", "-crf", "20", "-b:v", "0", "-deadline", "realtime", "-cpu-used", "8", f"{D}/clips/d0-promise.webm"])
m = json.load(open(f"{D}/clips/marks.json")); m["d0-promise"] = 0
# The tabs (op.html) were recorded starting after the old promise and the noise: start there.
m["op"] = 15.44
json.dump(m, open(f"{D}/clips/marks.json", "w"), indent=2)
print(f"opening: {OWN}s theirs, ours from {ours:.2f}s, sound {total:.2f}s, scene {length:.2f}s")
