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

MODEL_NAME = os.environ.get("WHISPER_MODEL", "medium")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
PORT = int(os.environ.get("WHISPER_PORT", "8765"))
MAX_BYTES = 12 * 1024 * 1024

# Nudges Whisper to write down what was said, slips and hesitations included, instead of tidying it up.
VERBATIM_PROMPT = "Euh... hier je suis allé à le marché avec ma amie, et, euh, je pense que il va faire beau."


def load_model():
    if DEVICE == "auto":
        attempts = [("cuda", "float16"), ("cpu", "int8")]
    else:
        attempts = [(DEVICE, "float16" if DEVICE == "cuda" else "int8")]
    last_error = None
    for device, compute_type in attempts:
        try:
            loaded = WhisperModel(MODEL_NAME, device=device, compute_type=compute_type)
            # The first GPU run is very slow while kernels initialise; do it now, not on the first recording.
            segments, _ = loaded.transcribe(np.zeros(16000, dtype=np.float32), language="fr")
            list(segments)
            return loaded, device
        except Exception as error:  # try the next device
            last_error = error
            print(f"Couldn't start Whisper on {device}: {error}", file=sys.stderr, flush=True)
    raise SystemExit(f"Whisper failed to start: {last_error}")


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
            self._send(200, {"ok": True, "model": MODEL_NAME, "device": device})
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
        # No language means Whisper detects it, so English turns work too.
        language = parse_qs(url.query).get("language", [None])[0] or None

        started = time.time()
        try:
            with lock:
                segments, info = model.transcribe(
                    io.BytesIO(audio),
                    language=language,
                    word_timestamps=True,
                    vad_filter=True,
                    condition_on_previous_text=False,
                    beam_size=5,
                    initial_prompt=VERBATIM_PROMPT,
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
                "language": info.language,
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
    model, device = load_model()
    lock = threading.Lock()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Whisper ready on http://127.0.0.1:{PORT} ({MODEL_NAME} on {device}). Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
