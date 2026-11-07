#!/usr/bin/env python3
"""Builds the demo from screencast frames, narration and plain overlays.

Footage keeps its real timestamps. Scenes are only trimmed at the tail or held on the last frame.
Usage: assemble.py <videoDir> <script.json>
"""
import json, os, re, subprocess, sys
FF = "/opt/homebrew/bin/ffmpeg"
V, SCRIPT = sys.argv[1], sys.argv[2]
RAW, AUDIO, OUT = f"{V}/raw", f"{V}/audio", f"{V}/build"
os.makedirs(OUT, exist_ok=True)
LEAD, TAIL = 0.6, 0.35
script = json.load(open(SCRIPT))
durs = json.load(open(f"{AUDIO}/durs.json"))

def run(*args):
    subprocess.run([FF, "-v", "error", "-y", *args], check=True)

def chunks(text):
    out = []
    for sent in re.findall(r"[^.]+(?:\.(?=\d)[^.]+)*\.", text):
        sent = sent.strip()
        if len(sent) <= 64:
            out.append(sent)
            continue
        parts, cur = [], ""
        for w in sent.split(" "):
            if cur and len(cur) + len(w) > 58:
                parts.append(cur)
                cur = w
            else:
                cur = f"{cur} {w}".strip()
        parts.append(cur)
        out.extend(parts)
    return out

caption_files = json.load(open(f"{OUT}/captions.json")) if os.path.exists(f"{OUT}/captions.json") else {}
parts = []
for s in script:
    sid = s["id"]
    target = LEAD + durs[sid] + TAIL
    out = f"{OUT}/{sid}.mp4"
    frames_dir = f"{RAW}/{sid}"
    if os.path.isdir(frames_dir):
        meta = json.load(open(f"{frames_dir}/frames.json"))
        fr = meta["frames"]
        lines = ["ffconcat version 1.0"]
        for i, f in enumerate(fr):
            nxt = fr[i + 1]["t"] if i + 1 < len(fr) else meta["stopped"]
            lines += [f"file '{os.path.abspath(frames_dir)}/{f['file']}'", f"duration {max(nxt - f['t'], 0.001):.4f}"]
        lines.append(f"file '{os.path.abspath(frames_dir)}/{fr[-1]['file']}'")
        listing = f"{OUT}/{sid}.ffconcat"
        open(listing, "w").write("\n".join(lines))
        src = ["-f", "concat", "-safe", "0", "-i", listing]
    else:
        src = ["-loop", "1", "-framerate", "30", "-i", f"{OUT}/{sid}.png"]
    inputs = [*src, "-i", f"{AUDIO}/{sid}.mp3"]
    # Hold the last frame if the scene is short. Nothing changes the playback rate.
    graph = f"[0:v]fps=30,scale=1920:1080:flags=lanczos,tpad=stop_mode=clone:stop_duration=30,trim=duration={target:.3f},setpts=PTS-STARTPTS[base];"
    last = "base"
    caps = []
    if not s.get("nocap"):
        pieces = chunks(s.get("cap", s["text"]))
        spoken = chunks(s["text"])
        total = sum(len(c) for c in pieces)
        t = LEAD
        for i, c in enumerate(pieces):
            d = durs[sid] * len(c) / total
            caps.append((f"{OUT}/cap/{sid}_{i}.png", t, t + d))
            t += d
    for i, (png, a, b) in enumerate(caps):
        inputs += ["-i", png]
        graph += f"[{last}][{i + 2}:v]overlay=0:0:enable='between(t,{a:.3f},{b:.3f})'[v{i}];"
        last = f"v{i}"
    graph += f"[1:a]adelay={int(LEAD * 1000)}:all=1,apad,atrim=duration={target:.3f},aresample=48000,aformat=channel_layouts=mono[a]"
    run(*inputs, "-filter_complex", graph, "-map", f"[{last}]", "-map", "[a]", "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-t", f"{target:.3f}", out)
    parts.append(out)
    print(sid, f"{target:.2f}s, frames from {'screencast' if os.path.isdir(frames_dir) else 'card'}", flush=True)
listing = f"{OUT}/all.txt"
open(listing, "w").write("\n".join(f"file '{os.path.abspath(p)}'" for p in parts))
run("-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", "-movflags", "+faststart", f"{V}/beforecoin-demo.mp4")
