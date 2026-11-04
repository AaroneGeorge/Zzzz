# Cut the recorded frames into the final demo MP4 with title cards, burned-in captions and speed-ups.
#   python3 -I scripts/video/edit.py <rec_dir> <cards_dir> <work_dir> <out.mp4> <captions.json>
# captions.json maps segment ids (see SEGMENTS below) to caption text; "\n" breaks lines.
import json, os, subprocess, sys, textwrap

REC, CARDS, WORK, OUT, CAPS = sys.argv[1:6]
os.makedirs(WORK, exist_ok=True)
d = json.load(open(f"{REC}/events.json"))
frames, events = d["frames"], d["events"]
caps = json.load(open(CAPS))
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_R = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def t_of(name, **kw):
    for e in events:
        if e["name"] == name and all(e.get(k) == v for k, v in kw.items()):
            return e["t"]
    return None


def need(name, **kw):
    t = t_of(name, **kw)
    if t is None:
        raise SystemExit(f"missing event {name} {kw}")
    return t


def first(*ts):
    return next(t for t in ts if t is not None)


E = {}
E["home"] = need("home")
E["jio_sub"] = need("jio_click")                   # include the typing / preset + Run clicks
E["j1"] = need("jio_step", idx=1, status="ok")
E["j2"] = need("jio_step", idx=2, status="ok")
E["j3"] = need("jio_step", idx=3, status="ok")
E["j4"] = need("jio_step", idx=4, status="ok")
E["j5run"] = first(t_of("jio_step", idx=5, status="running"), E["j4"])
E["j6"] = need("jio_step", idx=6, status="ok")
E["j7"] = first(t_of("jio_step", idx=7, status="ok"), t_of("jio_step", idx=7, status="skipped"), t_of("jio_step", idx=7, status="failed"), need("jio_done"))
E["jdone"] = need("jio_done")
E["exh"] = first(t_of("explorer_hover"), E["jdone"] + 5)
E["exo"] = t_of("explorer_open")
E["exc"] = t_of("explorer_close")
E["amz_click"] = need("amz_click")
E["amz_sub"] = need("amz_submitted")
E["amz_wait"] = need("amz_status", status="waiting_human")
E["amz_conf"] = need("amz_confirm_click")
E["amz_done"] = need("amz_done")
E["reveal"] = first(t_of("reveal_click"), E["amz_done"] + 2)   # the code is unmasked from here on: never show it
E["fk_click"] = need("fk_click")
E["fk_done"] = need("fk_done")
E["end"] = need("end")

import math
E["fk_den"] = first(t_of("fk_status", status="denied"), E["fk_done"])
WAIT = round(E["j6"] - E["j5run"])
AMZ_WAIT = round(E["amz_done"] - E["amz_conf"])
# (id, start, end, base speed, max output seconds, badge-template or None)
RAW = [
    ("home", E["home"], E["jio_sub"], 1, 5.0, None),
    ("jio_search", E["jio_sub"], E["j1"] + 1.5, 1.5, 5.0, None),
    ("jio_gate", E["j1"] + 1.5, E["j2"] + 2.5, 1, 4.5, None),
    ("jio_quote", E["j2"] + 2.5, E["j5run"] + 1.0, 1.25, 7.0, None),
    ("jio_pay", E["j5run"] + 1.0, E["j6"], 4, 16.0, "Sped up {x}x: the real wait was " + str(WAIT) + " s (real testnet confirmation)"),
    ("jio_deliver", E["j6"], E["exh"], 1.25, 7.0, None),
]
amz_from = E["exh"]
if E["exo"] and E["exc"]:
    RAW += [("explorer_link", E["exh"], E["exo"], 2, 3.0, None),
            ("explorer", E["exo"], E["exc"], 1, 8.0, None)]
    amz_from = E["exc"]
RAW += [
    ("amz_click", amz_from, E["amz_wait"], 2, 5.0, None),
    ("amz_confirm", E["amz_wait"], E["amz_conf"] + 1.5, 1, 5.5, None),
    ("amz_run", E["amz_conf"] + 1.5, E["amz_done"], 4, 20.0, "Sped up {x}x: real wait " + str(AMZ_WAIT) + " s (testnet pay + verify)"),
    ("amz_reveal", E["amz_done"], min(E["reveal"] - 0.02, E["fk_click"]), 1, 7.0, None),   # cut before the reveal click
    ("fk_search", E["fk_click"], E["fk_den"], 2, 4.3, None),
    ("fk_deny", E["fk_den"], E["fk_den"] + 6, 1, 6.0, None),
    ("mandate", E["fk_done"] + 4.5, E["end"], 1, 5.0, None),
]
# freeze a key frame: segment id -> (source time of the frame to hold, extra output seconds)
FREEZE = {
    "jio_gate": (E["j2"] + 2.3, 3.0),        # policy gate: auto-approved
    "jio_deliver": (E["j6"] + 0.6, 3.0),     # gateway verified with the view-only key
    "amz_reveal": (E["reveal"] - 0.05, max(0.0, 7.0 - (E["reveal"] - E["amz_done"]))),  # hold the masked code
}
if E["exo"] and E["exc"]:
    FREEZE["explorer"] = (E["exc"] - 0.3, 3.0)  # public explorer: shielded, amount + memo hidden
SEG = []
for sid, a_, b_, base, mx, tpl in RAW:
    ratio = (b_ - a_) / mx
    if ratio <= base * 1.3:
        sp = base                                   # a little long is fine
    elif tpl:
        sp = math.ceil(ratio)
    else:
        sp = math.ceil(ratio * 2) / 2               # 0.5 steps
    if tpl:
        badge = tpl.format(x=f"{sp:g}")
    elif sp >= 1.5:
        badge = f"Sped up {sp:g}x"
    else:
        badge = None
    SEG.append((sid, a_, b_, sp, badge))
# placeholders for captions: {JIO_HEIGHT}, {JIO_TXID8}
PH = {}
for e in events:
    if e["name"] == "jio_final" and e.get("run"):
        for st in e["run"]["steps"]:
            ids = st.get("ids") or {}
            if st["name"] == "pay" and ids.get("txid"):
                PH["JIO_TXID8"] = ids["txid"][:8]
                if ids.get("height"):
                    PH["JIO_HEIGHT"] = f"{int(ids['height']):,}"
for kk, vv in list(caps.items()):
    fill = lambda x: x.replace("{JIO_HEIGHT}", PH.get("JIO_HEIGHT", "?")).replace("{JIO_TXID8}", PH.get("JIO_TXID8", "?"))
    caps[kk] = [fill(x) for x in vv] if isinstance(vv, list) else fill(vv)
if t_of("jio_step", idx=7, status="ok") is None and "jio_deliver_failed" in caps:
    caps["jio_deliver"] = caps["jio_deliver_failed"]      # Bitrefill's test order failed in this take: say so
print("placeholders", PH)
CARD_SEG = [("card_title", 4.5), ("card_problem", 8.5), ("card_who", 7.0)]
END_SEG = [("card_guard", 7.0), ("card_end", 9.5)]

lines, timeline, t_out = [], [], 0.0


def add_card(name, dur):
    global t_out
    lines.append(f"file '{CARDS}/{name}.jpg'\nduration {dur:.4f}")
    timeline.append((name, t_out, t_out + dur, None))
    t_out += dur


for n, dur in CARD_SEG:
    add_card(n, dur)
for sid, a, b, sp, badge in SEG:
    if b <= a:
        continue
    fs = [f for f in frames if a <= f["t"] < b]
    # rules: every code on screen stays masked. After reveal_click the ₹700 code is visible until the next run starts.
    bad = [f["f"] for f in fs if E["reveal"] <= f["t"] < E["fk_click"]]
    if bad:
        raise SystemExit(f"segment {sid} would show the revealed code: {bad[:3]}")
    fz = FREEZE.get(sid)
    fz_f = max((f for f in fs if f["t"] <= fz[0]), key=lambda f: f["t"], default=None) if fz else None
    seg_start = t_out
    for i, f in enumerate(fs):
        nxt = fs[i + 1]["t"] if i + 1 < len(fs) else b
        dur = max(0.0, (nxt - f["t"])) / sp
        if fz_f is f:
            dur += fz[1]
        if dur <= 0:
            continue
        lines.append(f"file '{REC}/frames/{f['f']}'\nduration {dur:.4f}")
        t_out += dur
    timeline.append((sid, seg_start, t_out, badge))
for n, dur in END_SEG:
    add_card(n, dur)
lines.append(f"file '{CARDS}/{END_SEG[-1][0]}.jpg'")  # concat demuxer needs the last file repeated
open(f"{WORK}/list.txt", "w").write("\n".join(lines) + "\n")

for sid, a, b, badge in timeline:
    print(f"{sid:14s} {a:7.2f} → {b:7.2f}  ({b - a:5.2f}s){'  [' + badge + ']' if badge else ''}")
print(f"TOTAL {t_out:.2f}s")


def esc_path(p):
    return p.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


filters = ["fps=30", "scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv"]
k = 0
for sid, a, b, badge in timeline:
    txt = caps.get(sid)
    parts = txt if isinstance(txt, list) else ([txt] if txt else [])
    for pi, part in enumerate(parts):
        pa = a + (b - a) * pi / len(parts)
        pb = a + (b - a) * (pi + 1) / len(parts)
        # one drawtext per line (ffmpeg 8 draws a tofu glyph for '\n' in textfile); boxes tile seamlessly
        lines_ = [w for para in part.split("\n") for w in textwrap.wrap(para, 66)]
        n = len(lines_)
        for j, ln in enumerate(lines_):
            k += 1
            tf = f"{WORK}/cap{k:02d}.txt"
            open(tf, "w").write(ln)
            filters.append(
                f"drawtext=fontfile={FONT}:textfile='{esc_path(tf)}':fontsize=40:fontcolor=white:y_align=font"
                f":box=1:boxcolor=black@0.68:boxborderw=10|28:x=(w-text_w)/2:y=h-80-{(n - j) * 67}:enable='between(t,{pa:.3f},{pb:.3f})'")
    if badge:
        k += 1
        tf = f"{WORK}/cap{k:02d}.txt"
        open(tf, "w").write(badge)
        filters.append(
            f"drawtext=fontfile={FONT}:textfile='{esc_path(tf)}':fontsize=36:fontcolor=0x111111"
            f":box=1:boxcolor=0xf4b728@0.95:boxborderw=18:x=w-text_w-60:y=130:enable='between(t,{a:.3f},{b:.3f})'")
filters.append("format=yuv420p")
vf = ",".join(filters)
open(f"{WORK}/vf.txt", "w").write(vf)

cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
       "-f", "concat", "-safe", "0", "-i", f"{WORK}/list.txt",
       "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
       "-filter_script:v", f"{WORK}/vf.txt",
       "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-profile:v", "high", "-pix_fmt", "yuv420p", "-color_range", "tv",
       "-c:a", "aac", "-b:a", "64k", "-shortest", "-t", f"{t_out:.3f}",
       "-movflags", "+faststart", OUT]
subprocess.run(cmd, check=True)
json.dump([{"id": s, "start": a, "end": b, "badge": bd} for s, a, b, bd in timeline], open(f"{WORK}/timeline.json", "w"), indent=1)
print("wrote", OUT)
