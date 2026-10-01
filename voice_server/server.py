"""Local neural voice server for the French tutor.

Speaks her replies with XTTS-v2 on the GPU: one voice for both French and English, so she stays
the same person when she switches from a French sentence to an English explanation. Nothing leaves
this computer and there is no daily limit. Start it with:

    npm run voice        (or: voice_server/.venv/Scripts/python voice_server/server.py)

The model loads once at start-up and the GPU is warmed there too, so the first reply of a session
costs the same as the hundredth.

Two kinds of voice:
  * a built-in speaker that ships with XTTS (see /health for the list), and
  * a recording dropped into voice_server/voices as a wav, which she then imitates. A native
    French recording gives a much better French accent than the built-in speakers, most of whom
    are English. Use your own voice, or a public-domain or Creative Commons recording; never
    somebody's voice without their permission.

Environment variables:
    XTTS_PORT       port to listen on (default 8767)
    XTTS_DEVICE     "auto", "cuda" or "cpu" (default "auto")
    XTTS_SPEAKER    voice to use when the app doesn't name one
    XTTS_MODEL      model to load (default the XTTS v2 multilingual model)
"""

import io
import json
import os
import queue
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent
VOICES_DIR = HERE / "voices"

PORT = int(os.environ.get("XTTS_PORT", "8767"))
DEVICE = os.environ.get("XTTS_DEVICE", "auto")
MODEL = os.environ.get("XTTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
DEFAULT_SPEAKER = os.environ.get("XTTS_SPEAKER", "")
MAX_CHARS = 4_000
PAUSE_MS = 180  # a breath between two segments, so French and English don't run together

# Agreeing to the model's licence is the student's decision, not ours: setup.ps1 shows the terms
# and writes this file once they accept. Without it the model would prompt on a console nobody is
# watching, and the server would hang at start-up.
LICENCE_MARKER = HERE / ".licence-accepted"


def pick_device() -> str:
    import torch

    if DEVICE != "auto":
        return DEVICE
    return "cuda" if torch.cuda.is_available() else "cpu"


def pcm16_wav(samples, rate: int) -> bytes:
    """One mono 16-bit wav, which is what both the browser and the lip-sync server expect."""
    import numpy as np

    audio = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((audio * 32767.0).astype("<i2").tobytes())
    return buffer.getvalue()


class Synthesizer:
    def __init__(self):
        if not LICENCE_MARKER.exists():
            raise SystemExit(
                "The XTTS model licence hasn't been accepted yet. Run "
                "powershell -ExecutionPolicy Bypass -File .\\voice_server\\setup.ps1 "
                "- it shows the terms and asks you to accept them."
            )
        os.environ.setdefault("COQUI_TOS_AGREED", "1")  # accepted by the student in setup.ps1
        from TTS.api import TTS

        self.device = pick_device()
        self.tts = TTS(MODEL).to(self.device)
        self.rate = int(getattr(self.tts.synthesizer, "output_sample_rate", 24000))
        self.speakers = sorted(self.tts.speakers or [])
        self.voices = {p.stem: p for p in sorted(VOICES_DIR.glob("*.wav"))}

    def default(self) -> str:
        """Whatever the environment names, then a recording, then the first built-in speaker."""
        for candidate in (DEFAULT_SPEAKER, *self.voices, *self.speakers):
            if candidate:
                return candidate
        raise RuntimeError("XTTS reported no speakers and voices/ is empty.")

    def _voice_arguments(self, speaker: str) -> dict:
        """A recording in voices/ wins over a built-in name, so dropping a wav in just works."""
        if speaker in self.voices:
            return {"speaker_wav": str(self.voices[speaker])}
        if speaker in self.speakers:
            return {"speaker": speaker}
        fallback = self.default()
        return {"speaker_wav": str(self.voices[fallback])} if fallback in self.voices else {"speaker": fallback}

    def warm(self):
        """
        The first run on this thread compiles CUDA kernels, which is slow; the avatar server taught
        us to pay that here rather than in front of the student. It also means two replies can
        never fight over the GPU, because only this thread ever touches it.
        """
        start = time.time()
        self.say([{"lang": "fr", "text": "Bonjour, on commence ?"}], self.default())
        print(f"  warmed up in {time.time() - start:.0f}s", flush=True)

    def say(self, segments: list[dict], speaker: str) -> tuple[bytes, dict]:
        import numpy as np

        voice = self._voice_arguments(speaker)
        pause = np.zeros(int(self.rate * PAUSE_MS / 1000), dtype=np.float32)
        pieces = []
        for segment in segments:
            if pieces:
                pieces.append(pause)
            wave_form = self.tts.tts(
                text=segment["text"],
                language=segment["lang"],
                split_sentences=True,  # XTTS has a per-call text limit; this stays inside it
                **voice,
            )
            pieces.append(np.asarray(wave_form, dtype=np.float32))
        audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
        return pcm16_wav(audio, self.rate), {"seconds": round(len(audio) / self.rate, 2), "voice": speaker or self.default()}


class Worker(threading.Thread):
    """Owns the GPU: every request is handed to this one thread. See Synthesizer.warm."""

    def __init__(self):
        super().__init__(daemon=True)
        self.jobs: "queue.Queue[tuple]" = queue.Queue()
        self.ready = threading.Event()
        self.failure: BaseException | None = None
        self.synth: Synthesizer | None = None

    def run(self):
        try:
            self.synth = Synthesizer()
            self.synth.warm()
        except BaseException as error:  # SystemExit too: a missing licence must reach /health
            self.failure = error
            self.ready.set()
            return
        self.ready.set()
        recordings = ", ".join(self.synth.voices) or "none"
        print(
            f"Voice ready on http://127.0.0.1:{PORT} ({self.synth.device}, "
            f"{len(self.synth.speakers)} built-in speakers, recordings: {recordings}).",
            flush=True,
        )
        while True:
            segments, speaker, result, done = self.jobs.get()
            try:
                result["wav"], result["timings"] = self.synth.say(segments, speaker)
            except Exception as error:
                result["error"] = error
            finally:
                done.set()

    def speak(self, segments: list[dict], speaker: str, timeout: float = 180.0) -> dict:
        result: dict = {}
        done = threading.Event()
        self.jobs.put((segments, speaker, result, done))
        if not done.wait(timeout):
            raise TimeoutError("The voice took too long to answer.")
        if "error" in result:
            raise result["error"]
        return result


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            return self._json(404, {"error": "Not found"})
        if not worker.ready.is_set():
            return self._json(503, {"ok": False, "starting": True})
        if worker.failure or not worker.synth:
            return self._json(500, {"ok": False, "error": str(worker.failure)})
        self._json(
            200,
            {
                "ok": True,
                "device": worker.synth.device,
                "speakers": worker.synth.speakers,
                "voices": sorted(worker.synth.voices),
                "default": worker.synth.default(),
                "rate": worker.synth.rate,
            },
        )

    def do_POST(self):
        if urlparse(self.path).path != "/speak":
            return self._json(404, {"error": "Not found"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return self._json(400, {"error": "Nothing to say."})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return self._json(400, {"error": "That wasn't valid JSON."})

        segments = [
            {"lang": s["lang"], "text": s["text"].strip()}
            for s in (body.get("segments") or [])
            if isinstance(s, dict) and s.get("lang") in ("fr", "en") and isinstance(s.get("text"), str) and s["text"].strip()
        ]
        if not segments:
            return self._json(400, {"error": "Nothing to say."})
        if sum(len(s["text"]) for s in segments) > MAX_CHARS:
            return self._json(413, {"error": "That reply is too long to speak."})
        speaker = body.get("speaker") if isinstance(body.get("speaker"), str) else ""

        if not worker.ready.is_set():
            return self._json(503, {"error": "The voice is still warming up."})
        if worker.failure:
            return self._json(500, {"error": str(worker.failure)})

        started = time.time()
        try:
            result = worker.speak(segments, speaker or "")
        except Exception as error:
            print(f"Speech failed: {error}", file=sys.stderr, flush=True)
            return self._json(500, {"error": f"Couldn't speak that reply: {error}"})

        wav, timings = result["wav"], result["timings"]
        took = round(time.time() - started, 2)
        print(f"spoke {timings['seconds']}s in {took}s as {timings['voice']}", flush=True)
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(wav)))
        self.send_header("x-speech", json.dumps({**timings, "took": took}))
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, format, *args):
        pass  # failures are printed above


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print("Loading XTTS (a minute or so: the model, then warming the GPU)...", flush=True)
    worker = Worker()
    worker.start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Listening on http://127.0.0.1:{PORT}; /health says when she is ready.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
