"""Runs the recordings the app kept through several Whisper models, side by side.

The app keeps your last few recordings in data/recordings, each with the text it produced at the
time. This replays those exact seconds of speech through whichever models you name, so a change to
the transcription can be judged on your own voice instead of on a guess.

    python whisper_server/compare.py
    python whisper_server/compare.py --models medium large-v3
    python whisper_server/compare.py --models medium:float16 large-v3:float16 --clips 5

Run it with the tutor's own Whisper server stopped: the models here want the same GPU memory.

Nothing is written. Read the transcripts and decide which model heard you properly - the point is
that you are the only one who knows what you actually said.
"""

import argparse
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

ROOT = Path(__file__).parent.parent
RECORDINGS = Path(os.environ.get("DATA_DIR", ROOT / "data")) / "recordings"

# The same settings the server transcribes with, so a difference here is the model and nothing else.
PROMPTS = {
    "fr": "Euh... hier je suis allé à le marché avec ma amie, et, euh, je pense que il va faire beau.",
    "en": "Um... yesterday I goed to the market with my friend, and, uh, I think it will be nice tomorrow.",
}


def load(spec):
    """"large-v3" or "large-v3:float16" - the compute type defaults to float16 on the GPU."""
    name, _, compute = spec.partition(":")
    compute = compute or "float16"
    started = time.time()
    try:
        model = WhisperModel(name, device="cuda", compute_type=compute)
        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="fr")
        list(segments)
    except Exception as error:
        print(f"  {spec}: unavailable ({type(error).__name__}: {str(error)[:70]})", file=sys.stderr)
        return None
    print(f"  {spec}: ready in {time.time() - started:.1f}s", file=sys.stderr)
    return model


def transcribe(model, samples, language):
    started = time.time()
    segments, _ = model.transcribe(
        samples,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
        beam_size=5,
        initial_prompt=PROMPTS[language],
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return text, time.time() - started


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", default=["medium", "large-v3"])
    parser.add_argument("--clips", type=int, default=0, help="only the newest N recordings")
    args = parser.parse_args()

    stems = sorted(p.stem for p in RECORDINGS.glob("*.wav"))
    if not stems:
        print(f"No recordings in {RECORDINGS}. Speak a few turns in the app first.")
        return
    if args.clips:
        stems = stems[-args.clips :]

    print(f"Loading {len(args.models)} model(s):", file=sys.stderr)
    models = [(spec, load(spec)) for spec in args.models]
    models = [(spec, m) for spec, m in models if m]
    if not models:
        return print("None of those models could run on this GPU.")

    print(f"\n{len(stems)} recording(s) from {RECORDINGS}\n")
    for stem in stems:
        note = {}
        note_file = RECORDINGS / f"{stem}.json"
        if note_file.exists():
            note = json.loads(note_file.read_text(encoding="utf-8"))
        language = (note.get("heard") or {}).get("language") or "fr"
        samples = decode_audio(io.BytesIO((RECORDINGS / f"{stem}.wav").read_bytes()), sampling_rate=16000)

        print(f"{stem}  ({len(samples) / 16000:.1f}s, taken as {language})")
        if note.get("text") is not None:
            print(f"  {'at the time':22} {note['text']!r}")
        for spec, model in models:
            text, took = transcribe(model, samples, language)
            print(f"  {spec:22} {text!r}   [{took:.2f}s]")
        print()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
