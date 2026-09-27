"""
Renders the architecture flows as an animated GIF and an mp4.

    python scripts/architecture-gif.py                       every flow, a readable pace
    python scripts/architecture-gif.py --pace 1.3            slower still
    python scripts/architecture-gif.py --only 0 --name turn  just the spoken turn

Each hop travels quickly and then holds, so the movement stays lively while the caption stays on
screen long enough to read. --pace is how long one hop lasts from start to finish, in seconds.
"""

import argparse
import os
import shutil
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs")
FRAMES = os.path.join(OUT, "_frames")
FFMPEG = os.path.join(ROOT, "avatar_server", "bin", "ffmpeg.exe")

W, H = 1200, 768
FPS = 12
# How much of a hop the packet spends moving; the rest it sits still and you read the caption.
TRAVEL_SHARE = 0.45

BG = (15, 17, 21)
PANEL = (22, 25, 34)
LINE = (42, 47, 62)
TEXT = (232, 234, 240)
MUTED = (148, 155, 176)
DIM = (72, 79, 98)
LIVE = (240, 180, 41)

KINDS = {
    "browser": (139, 131, 232),
    "route": (74, 154, 232),
    "domain": (43, 185, 140),
    "engine": (232, 116, 74),
    "cloud": (214, 92, 138),
    "data": (139, 143, 158),
}

COLS = [
    (36, "BROWSER", "browser"),
    (268, "API ROUTES", "route"),
    (500, "DOMAIN", "domain"),
    (732, None, "engine"),  # labelled as two groups instead: cloud, and this machine
    (964, "DATA", "data"),
]
NW, NH, PITCH, TOP = 200, 48, 60, 134

# name: (col, row, label, local?)  local marks what runs on this machine
NODES = {
    "mic": (0, 0, "You speak", None),
    "tutorPage": (0, 1, "Tutor page", None),
    "player": (0, 2, "She answers", None),
    "practicePage": (0, 3, "Practice page", None),
    "progressPage": (0, 4, "Progress page", None),
    "settingsPage": (0, 5, "Settings page", None),
    "apiTranscribe": (1, 0, "/api/transcribe", None),
    "apiTutor": (1, 1, "/api/tutor", None),
    "apiEnd": (1, 2, "/api/session/end", None),
    "apiAvatar": (1, 3, "/api/avatar", None),
    "apiFace": (1, 4, "/api/avatar/face", None),
    "apiPractice": (1, 5, "/api/practice", None),
    "apiQuiz": (1, 6, "/api/quiz", None),
    "apiCoach": (1, 7, "/api/coach", None),
    "brain": (2, 1, "brain.ts", None),
    "learner": (2, 2, "learner.ts", None),
    "srs": (2, 3, "srs.ts", None),
    "ttsCache": (2, 4, "ttsCache.ts", None),
    "store": (2, 5, "store.ts", None),
    # The two that leave this machine sit together at the top, boxed off from the four that don't.
    "claude": (3, 0, "Claude", False),
    "gemini": (3, 1, "Gemini", False),
    "whisper": (3, 3.05, "Whisper :8765", True),
    "ollama": (3, 4.05, "Ollama :11434", True),
    "piper": (3, 5.05, "Piper :8768", True),
    "wav2lip": (3, 6.05, "Wav2Lip :8766", True),
    "sessions": (4, 0, "sessions/", None),
    "mistakes": (4, 1, "mistakes.json", None),
    "cards": (4, 2, "cards.json", None),
    "profile": (4, 3, "profile.json", None),
    "speechCache": (4, 4, "speech-cache/", None),
}

FLOWS = [
    ("A spoken turn", [
        ("mic", "tutorPage", "you speak; silence ends the turn"),
        ("tutorPage", "apiTranscribe", "16 kHz WAV"),
        ("apiTranscribe", "whisper", "the audio"),
        ("whisper", "apiTranscribe", "French or English only, never a third language"),
        ("apiTranscribe", "tutorPage", "the words, and how fast you said them"),
        ("tutorPage", "apiTutor", "the sentence"),
        ("apiTutor", "learner", "what has he got wrong before?"),
        ("learner", "ollama", "embed it"),
        ("ollama", "learner", "a vector"),
        ("learner", "mistakes", "the 5 most frequent, the 3 most similar"),
        ("apiTutor", "brain", "history + that context"),
        ("brain", "claude", "system prompt, replayed turns, schema"),
        ("claude", "brain", "corrections, speech, vocabulary"),
        ("apiTutor", "store", "save both turns"),
        ("store", "sessions", "flushed, then swapped in"),
        ("apiTutor", "tutorPage", "corrections shown, but NOT filed yet"),
        ("tutorPage", "apiAvatar", "her reply, tagged fr and en"),
        ("apiAvatar", "ttsCache", "has she said this before?"),
        ("apiAvatar", "piper", "no, synthesise it"),
        ("piper", "apiAvatar", "one WAV, 10x faster than real time"),
        ("apiAvatar", "wav2lip", "that WAV + her photo"),
        ("wav2lip", "apiAvatar", "an mp4, her mouth moving"),
        ("apiAvatar", "speechCache", "keep both, so saying it again is free"),
        ("apiAvatar", "player", "she answers"),
    ]),
    ("Ending a session: the gate", [
        ("tutorPage", "apiEnd", "end the session"),
        ("apiEnd", "brain", "the whole transcript"),
        ("brain", "claude", "now rule on every correction she made"),
        ("claude", "brain", "confirmed / amended / wrong"),
        ("apiEnd", "learner", "only the ones it stands behind"),
        ("learner", "mistakes", "a new entry, or count + 1 on a repeat"),
        ("learner", "srs", "a card for each genuinely new mistake"),
        ("srs", "cards", "due now, then at growing intervals"),
        ("apiEnd", "store", "the level, only if 150 words over 4 turns"),
        ("store", "profile", "levels, focus areas, next session plan"),
    ]),
    ("Practising what you got wrong", [
        ("practicePage", "apiPractice", "what is due?"),
        ("apiPractice", "store", "read the deck"),
        ("store", "cards", "every card with its due date"),
        ("apiPractice", "srs", "you graded it: good"),
        ("srs", "cards", "new ease, interval, next due date"),
    ]),
    ("A written quiz from your own mistakes", [
        ("practicePage", "apiQuiz", "make me a quiz"),
        ("apiQuiz", "store", "read the evidence"),
        ("store", "mistakes", "what he keeps getting wrong"),
        ("apiQuiz", "gemini", "write accurate questions, as JSON"),
        ("gemini", "apiQuiz", "only the ones that validate"),
    ]),
    ("Asking the coach about your level", [
        ("progressPage", "apiCoach", "how am I actually doing?"),
        ("apiCoach", "store", "read everything about him"),
        ("store", "profile", "levels, sessions, mistakes"),
        ("apiCoach", "claude", "answer from that evidence and nothing else"),
        ("claude", "apiCoach", "the answer, in English"),
    ]),
    ("Changing her face", [
        ("settingsPage", "apiFace", "a new portrait"),
        ("apiFace", "wav2lip", "find a face in this"),
        ("wav2lip", "apiFace", "found it, measured and kept"),
        ("apiFace", "settingsPage", "added, and selected for you"),
    ]),
]


def font(name, size):
    for path in (rf"C:\Windows\Fonts\{name}", rf"C:\Windows\Fonts\segoeui.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


F_TITLE = font("seguisb.ttf", 30)
F_FLOW = font("seguisb.ttf", 23)
F_NODE = font("segoeui.ttf", 16)
F_HEAD = font("seguisb.ttf", 12)
F_CAP = font("segoeui.ttf", 27)
F_SMALL = font("segoeui.ttf", 15)
F_TAG = font("seguisb.ttf", 11)


def blend(c, bg, a):
    return tuple(int(bg[i] + (c[i] - bg[i]) * a) for i in range(3))


def box(name):
    c, r, _, _ = NODES[name]
    return COLS[c][0], TOP + r * PITCH, NW, NH


def bezier(p0, p1, p2, p3, n=90):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        pts.append((x, y))
    return pts


def edge_points(a, b):
    ax, ay, aw, ah = box(a)
    bx, by, bw, bh = box(b)
    ca, cb = NODES[a][0], NODES[b][0]
    if ca == cb:
        x = ax + aw
        y1, y2 = ay + ah / 2, by + bh / 2
        k = 46
        return bezier((x, y1), (x + k, y1), (x + k, y2), (x, y2))
    fwd = cb > ca
    sx = ax + aw if fwd else ax
    tx = bx if fwd else bx + bw
    sy, ty = ay + ah / 2, by + bh / 2
    dx = abs(tx - sx) * 0.42 * (1 if fwd else -1)
    return bezier((sx, sy), (sx + dx, sy), (tx - dx, ty), (tx, ty))


def draw_frame(flow_ix, step_ix, t, title_card=False):
    """t is 0..1 through the current hop; title_card shows the flow name alone."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    flow_name, steps = FLOWS[flow_ix]

    d.text((36, 26), "French tutor", font=F_TITLE, fill=TEXT)
    d.text((36, 64), "a French conversation partner that runs on one laptop", font=F_SMALL, fill=DIM)
    d.rounded_rectangle((W - 330, 30, W - 292, 50), radius=5, fill=blend(KINDS["engine"], BG, 0.5))
    d.text((W - 311, 40), "local", font=F_TAG, fill=(255, 255, 255), anchor="mm")
    d.text((W - 282, 31), "runs on this machine", font=F_SMALL, fill=MUTED)
    d.rounded_rectangle((W - 330, 56, W - 292, 76), radius=5, fill=blend(KINDS["cloud"], BG, 0.5))
    d.text((W - 311, 66), "cloud", font=F_TAG, fill=(255, 255, 255), anchor="mm")
    d.text((W - 282, 57), "leaves this machine", font=F_SMALL, fill=MUTED)

    live = set()
    for a, b, _ in steps:
        live.add(a)
        live.add(b)

    for cx, label, kind in COLS:
        if label:
            d.text((cx, TOP - 26), label, font=F_HEAD, fill=DIM)

    # The whole point of the middle-right column: two of these are somebody else's computer.
    ecx = COLS[3][0]
    for rows, tint, title in (((0, 1), KINDS["cloud"], "CLOUD"), ((3.05, 6.05), KINDS["engine"], "ON THIS MACHINE")):
        gy1 = TOP + rows[0] * PITCH
        gy2 = TOP + rows[1] * PITCH + NH
        d.rounded_rectangle((ecx - 13, gy1 - 13, ecx + NW + 13, gy2 + 13), radius=12,
                            outline=blend(tint, BG, 0.38), width=1)
        d.text((ecx - 13, gy1 - 30), title, font=F_HEAD, fill=blend(tint, BG, 0.75))

    for name, (c, r, label, local) in NODES.items():
        x, y, w, h = box(name)
        col = KINDS["cloud"] if local is False else KINDS[COLS[c][2]]
        on = name in live
        fill = blend(col, BG, 0.11 if on else 0.04)
        outline = blend(col, BG, 0.55 if on else 0.14)
        label_col = blend(TEXT, BG, 0.75) if on else blend(TEXT, BG, 0.20)
        width = 1
        hot = not title_card and step_ix is not None and name in (steps[step_ix][0], steps[step_ix][1])
        if hot:
            fill = blend(col, BG, 0.46)
            outline = blend(col, (255, 255, 255), 0.25)
            label_col = (255, 255, 255)
            width = 2
            d.rounded_rectangle((x - 4, y - 4, x + w + 4, y + h + 4), radius=10, outline=blend(col, BG, 0.45), width=2)
        d.rounded_rectangle((x, y, x + w, y + h), radius=8, fill=fill, outline=outline, width=width)
        d.text((x + 14, y + h / 2), label, font=F_NODE, fill=label_col, anchor="lm")
        if local is not None:
            # Said in words on every engine, every frame, so it never depends on noticing a colour.
            tag = "local" if local else "cloud"
            tw = 38
            tx, ty = x + w - tw - 9, y + h / 2 - 9
            d.rounded_rectangle((tx, ty, tx + tw, ty + 18), radius=5,
                                fill=blend(col, BG, 0.55 if on else 0.16))
            d.text((tx + tw / 2, ty + 9), tag, font=F_TAG,
                   fill=(255, 255, 255) if on else blend(TEXT, BG, 0.3), anchor="mm")

    if not title_card and step_ix is not None:
        for k in range(step_ix):
            pts = edge_points(steps[k][0], steps[k][1])
            d.line(pts, fill=blend(LIVE, BG, 0.30), width=2, joint="curve")
        pts = edge_points(steps[step_ix][0], steps[step_ix][1])
        cut = max(2, int(len(pts) * t))
        d.line(pts[:cut], fill=LIVE, width=3, joint="curve")
        px, py = pts[min(cut, len(pts)) - 1]
        d.ellipse((px - 9, py - 9, px + 9, py + 9), fill=blend(LIVE, BG, 0.30))
        d.ellipse((px - 4.5, py - 4.5, px + 4.5, py + 4.5), fill=LIVE)

    d.line((36, 648, W - 36, 648), fill=LINE, width=1)
    d.text((36, 668), flow_name, font=F_FLOW, fill=LIVE)
    if title_card or step_ix is None:
        d.text((36, 703), f"{len(steps)} steps", font=F_CAP, fill=blend(TEXT, BG, 0.45))
    else:
        a, b, caption = steps[step_ix]
        d.text((36, 703), caption, font=F_CAP, fill=TEXT)
        # Spelled out, so there is never any doubt which two boxes the dot just travelled between.
        d.text((36, 738), f"{NODES[a][2]}   →   {NODES[b][2]}", font=F_SMALL, fill=MUTED)
        d.text((W - 36, 672), f"{step_ix + 1}/{len(steps)}", font=F_SMALL, fill=DIM, anchor="rt")
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pace", type=float, default=0.95, help="seconds per hop (default 0.95)")
    ap.add_argument("--only", type=int, default=None, help="render a single flow, by index from 0")
    ap.add_argument("--name", default="french-tutor-architecture", help="output file stem")
    args = ap.parse_args()

    per_hop = max(2, round(args.pace * FPS))
    travel = max(1, round(per_hop * TRAVEL_SHARE))
    hold = per_hop - travel
    title_frames = max(2, round(1.3 * FPS))
    flows = list(enumerate(FLOWS))
    if args.only is not None:
        flows = [flows[args.only]]

    if os.path.isdir(FRAMES):
        shutil.rmtree(FRAMES)
    os.makedirs(FRAMES)
    i = 0
    for fi, (name, steps) in flows:
        for _ in range(title_frames):
            draw_frame(fi, None, 0, title_card=True).save(f"{FRAMES}/f{i:04d}.png")
            i += 1
        for si in range(len(steps)):
            for k in range(travel):
                draw_frame(fi, si, (k + 1) / travel).save(f"{FRAMES}/f{i:04d}.png")
                i += 1
            # The packet has arrived; hold it there so the caption can actually be read.
            held = draw_frame(fi, si, 1.0)
            for _ in range(hold):
                held.save(f"{FRAMES}/f{i:04d}.png")
                i += 1
        for _ in range(round(FPS * 0.5)):
            draw_frame(fi, len(steps) - 1, 1.0).save(f"{FRAMES}/f{i:04d}.png")
            i += 1
    print(f"{i} frames, {i / FPS:.1f}s at {args.pace}s per hop ({travel} moving, {hold} held)")

    gif = os.path.join(OUT, f"{args.name}.gif")
    mp4 = os.path.join(OUT, f"{args.name}.mp4")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", f"{FRAMES}/f%04d.png",
                    "-vf", "split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
                    "-loop", "0", gif], check=True)
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", f"{FRAMES}/f%04d.png",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4], check=True)
    shutil.rmtree(FRAMES, ignore_errors=True)
    for p in (gif, mp4):
        print(f"{os.path.basename(p)}: {os.path.getsize(p) / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
