"""Local Whisper server for the French tutor.

Transcribes recordings with faster-whisper and returns a timing for every word, which the app
uses to measure speaking speed. Start it with:

    npm run whisper        (or: python whisper_server/server.py)

Environment variables:
    WHISPER_MODEL   model name or path (default "medium")
    WHISPER_DEVICE  "auto", "cuda" or "cpu" (default "auto": GPU if available)
    WHISPER_PORT    port to listen on (default 8765)
"""

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

MODEL_NAME = os.environ.get("WHISPER_MODEL", "medium")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
# How the weights are stored on the GPU. "int8_float16" halves them, which is what lets large-v3 sit
# beside the lip-sync model on an 8 GB card; unset keeps the old float16. Ignored on the CPU, which
# only has int8 worth using.
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "")
PORT = int(os.environ.get("WHISPER_PORT", "8765"))
MAX_BYTES = 12 * 1024 * 1024

# The only two languages a lesson is ever in. Whisper's own detector chooses between all ninety-nine,
# which on an accented learner's short sentence has transcribed French into Persian and into Hindi -
# phonetically, in the wrong script, so nothing downstream could tell it had happened.
CANDIDATES = ("fr", "en")
# Which one to believe when neither is convincing. The lesson is in French, so an unclear recording is
# far more likely to be poor French than to be English.
FALLBACK = os.environ.get("WHISPER_FALLBACK_LANGUAGE", "fr")
# Two separate doubts, because they mean different things. MIN_MARGIN is how far ahead the winner is
# of the other candidate: below it, the two are too close to call. MIN_LIKELIHOOD is how probable the
# winner was among all ninety-nine languages: below it, the recording didn't sound like either of ours,
# which is the case that used to come back as Persian.
MIN_MARGIN = float(os.environ.get("WHISPER_MIN_LANGUAGE_MARGIN", "0.6"))
MIN_LIKELIHOOD = float(os.environ.get("WHISPER_MIN_LANGUAGE_LIKELIHOOD", "0.5"))

# Nudges Whisper to write down what was said, slips and hesitations included, instead of tidying it up.
# One per language: a French prompt in front of an English recording does the same damage in miniature
# that a mis-detected language does outright.
VERBATIM_PROMPTS = {
    "fr": "Euh... hier je suis allé à le marché avec ma amie, et, euh, je pense que il va faire beau.",
    "en": "Um... yesterday I goed to the market with my friend, and, uh, I think it will be nice tomorrow.",
}


# How many candidate transcriptions Whisper keeps while decoding. More is slower and usually, but not
# always, more accurate; this is a learner's hesitant speech, so it is measured rather than assumed.
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "5"))


def load_model():
    if DEVICE == "auto":
        attempts = [("cuda", "float16"), ("cpu", "int8")]
    else:
        attempts = [(DEVICE, "float16" if DEVICE == "cuda" else "int8")]
    if COMPUTE_TYPE:
        attempts = [(device, COMPUTE_TYPE if device == "cuda" else "int8") for device, _ in attempts]
    last_error = None
    for device, compute_type in attempts:
        try:
            loaded = WhisperModel(MODEL_NAME, device=device, compute_type=compute_type)
            # The first GPU run is very slow while kernels initialise; do it now, not on the first recording.
            segments, _ = loaded.transcribe(np.zeros(16000, dtype=np.float32), language="fr")
            list(segments)
            return loaded, device, compute_type
        except Exception as error:  # try the next device
            last_error = error
            print(f"Couldn't start Whisper on {device}: {error}", file=sys.stderr, flush=True)
    raise SystemExit(f"Whisper failed to start: {last_error}")


def choose_language(samples):
    """
    French or English, whichever the recording is more likely to be - and nothing else.

    Whisper scores every language it knows; this reads those scores and throws away all but the two a
    lesson can be in. Returns the chosen language, the margin over the other candidate, the winner's
    likelihood among all languages, whether both were convincing, and what Whisper would have picked
    left to itself - that last one only so a bad turn can be explained afterwards.
    """
    try:
        _, _, ranked = model.detect_language(audio=samples, vad_filter=True, language_detection_segments=2)
    except Exception as error:  # a detection failure must not cost the student their turn
        print(f"Language detection failed, assuming {FALLBACK}: {error}", file=sys.stderr, flush=True)
        return FALLBACK, 0.0, 0.0, False, None

    scores = dict(ranked)
    unconstrained = max(scores, key=scores.get) if scores else None
    pair = {code: scores.get(code, 0.0) for code in CANDIDATES}
    best = max(pair, key=pair.get)
    total = sum(pair.values())
    margin = (pair[best] / total) if total > 0 else 0.0
    likelihood = pair[best]
    sure = margin >= MIN_MARGIN and likelihood >= MIN_LIKELIHOOD
    if not sure:
        print(
            f"Unsure of the language (margin {margin:.2f}, likelihood {likelihood:.2f}, "
            f"Whisper's own pick {unconstrained}); using {FALLBACK if not sure else best}.",
            file=sys.stderr,
            flush=True,
        )
    return (best if sure else FALLBACK), margin, likelihood, sure, unconstrained


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._send(200, {"ok": True, "model": MODEL_NAME, "device": device, "compute": compute})
        else:
            self._send(404, {"error": "Not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self._send(404, {"error": "Not found"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return self._send(400, {"error": "The recording was empty."})
        if length > MAX_BYTES:
            return self._send(413, {"error": "The recording is too long."})
        audio = self.rfile.read(length)
        # The app may name the language; otherwise it is French or English, decided below.
        query = parse_qs(url.query)
        asked = query.get("language", [None])[0] or None
        # Knobs for comparing settings against real recordings; the defaults are what the app uses.
        try:
            beam = max(1, min(10, int(query.get("beam", [BEAM_SIZE])[0])))
        except ValueError:
            beam = BEAM_SIZE
        timed = query.get("words", ["1"])[0] != "0"
        if asked is not None and asked not in CANDIDATES:
            return self._send(400, {"error": f"Language must be one of {', '.join(CANDIDATES)}."})

        started = time.time()
        try:
            with lock:
                samples = decode_audio(io.BytesIO(audio), sampling_rate=16000)
                if asked:
                    language, margin, likelihood, sure, unconstrained = asked, 1.0, 1.0, True, asked
                else:
                    language, margin, likelihood, sure, unconstrained = choose_language(samples)
                segments, info = model.transcribe(
                    samples,
                    language=language,
                    word_timestamps=timed,
                    vad_filter=True,
                    condition_on_previous_text=False,
                    beam_size=beam,
                    initial_prompt=VERBATIM_PROMPTS[language],
                )
                segments = list(segments)
        except Exception as error:
            print(f"Transcription failed: {error}", file=sys.stderr, flush=True)
            return self._send(500, {"error": f"Whisper couldn't transcribe the recording: {error}"})

        words = [
            {"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3), "probability": round(w.probability, 3)}
            for s in segments
            for w in (s.words or [])
        ]
        self._send(
            200,
            {
                "text": " ".join(s.text.strip() for s in segments).strip(),
                "language": language,
                "languageMargin": round(margin, 3),
                "languageLikelihood": round(likelihood, 3),
                "languageCertain": sure,
                "languageDetected": unconstrained,
                "duration": round(info.duration, 3),
                "words": words,
                "tokens": sum(len(s.tokens) for s in segments),
                "model": MODEL_NAME,
                "seconds": round(time.time() - started, 3),
            },
        )

    def log_message(self, format, *args):
        pass  # keep the console quiet; failures are printed above


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"Loading Whisper '{MODEL_NAME}' (the first start can take a minute)...", flush=True)
    model, device, compute = load_model()
    lock = threading.Lock()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Whisper ready on http://127.0.0.1:{PORT} ({MODEL_NAME}, {compute} on {device}). Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
