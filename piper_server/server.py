"""Local voice server for the French tutor, using Piper.

Speaks her replies on the CPU, several times faster than real time, so a reply is ready before she
would have finished drawing breath. Nothing leaves this computer and there is no daily limit.
Start it with:

    npm run piper        (or: piper_server/.venv/Scripts/python piper_server/server.py)

Piper's voices are each trained on one language, so she uses two: a French one for the French and an
English one for the explanations. They are two different speakers, which is the price of this being
instant; voice_server (XTTS) keeps one voice across both languages but is far too slow to converse
with on this machine.

Put more voices in piper_server/voices as an .onnx and .onnx.json pair (setup.ps1 fetches a few), and
they appear on the Settings page. A voice with several speakers in it is listed once per speaker.

Environment variables:
    PIPER_PORT      port to listen on (default 8768)
    PIPER_VOICE_FR  French voice to use when the app doesn't name one
    PIPER_VOICE_EN  English voice to use when the app doesn't name one
    PIPER_FR_SPEED  how fast she speaks French, 1.0 being the voice's own pace (default 0.85)
    PIPER_EN_SPEED  the same for English (default 0.85). Both are only fallbacks: the app names a
                    speed on every request, set on its Settings page.
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

import numpy as np
from piper import PiperVoice, SynthesisConfig

HERE = Path(__file__).parent
VOICES_DIR = HERE / "voices"

PORT = int(os.environ.get("PIPER_PORT", "8768"))
DEFAULT_FR = os.environ.get("PIPER_VOICE_FR", "")
DEFAULT_EN = os.environ.get("PIPER_VOICE_EN", "")
# Fallbacks only: the app sends a speed with every request. Both languages start just under the
# voice's own pace, because full pace is quick for someone learning - the English especially, since
# that is where the explanations are.
DEFAULT_SPEED = {
    "fr": float(os.environ.get("PIPER_FR_SPEED", "0.85")),
    "en": float(os.environ.get("PIPER_EN_SPEED", "0.85")),
}
SPEED_RANGE = (0.6, 1.15)
MAX_CHARS = 4_000
PAUSE_MS = 180  # a breath between segments, so French and English don't run together


def speed_for(language: str, asked: dict[str, float] | None) -> float:
    """The pace for one language: what the app asked for, clamped, else this server's own default."""
    fallback = DEFAULT_SPEED.get(language, 1.0)
    try:
        wanted = float((asked or {}).get(language, fallback))
    except (TypeError, ValueError):
        return fallback
    low, high = SPEED_RANGE
    return min(high, max(low, wanted)) if wanted == wanted else fallback  # NaN keeps the default


def pcm16_wav(audio: np.ndarray, rate: int) -> bytes:
    """One mono 16-bit wav, which is what both the browser and the lip-sync server expect."""
    clipped = np.clip(audio, -1.0, 1.0)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((clipped * 32767.0).astype("<i2").tobytes())
    return buffer.getvalue()


def resample(audio: np.ndarray, source: int, target: int) -> np.ndarray:
    """
    Voices don't agree on a sample rate (most are 22.05 kHz, one of the French ones is 44.1), and a
    single clip can only have one. We always resample upwards to the highest rate in the clip, so
    this is interpolation rather than decimation and needs no anti-aliasing filter.
    """
    if source == target or audio.size == 0:
        return audio
    count = int(round(audio.size * target / source))
    return np.interp(np.linspace(0.0, audio.size - 1, count), np.arange(audio.size), audio).astype(np.float32)


class Catalogue:
    """The voices on disk. A multi-speaker file is listed once per speaker, as "voice#speaker"."""

    def __init__(self):
        self.entries: dict[str, dict] = {}
        for config_path in sorted(VOICES_DIR.glob("*.onnx.json")):
            model = config_path.with_suffix("")  # drops ".json", leaving ".onnx"
            if not model.exists():
                print(f"  skipping {config_path.name}: no {model.name} beside it", file=sys.stderr, flush=True)
                continue
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except Exception as error:
                print(f"  skipping {config_path.name}: {error}", file=sys.stderr, flush=True)
                continue
            name = model.name[: -len(".onnx")]
            speakers = config.get("speaker_id_map") or {}
            shared = {
                "model": model,
                "language": (config.get("language") or {}).get("code", name[:5]).replace("_", "-"),
                "rate": int(config.get("audio", {}).get("sample_rate", 22050)),
                "quality": name.rsplit("-", 1)[-1],
            }
            if speakers:
                for speaker, speaker_id in sorted(speakers.items(), key=lambda kv: kv[1]):
                    self.entries[f"{name}#{speaker}"] = {**shared, "speaker_id": int(speaker_id)}
            else:
                self.entries[name] = {**shared, "speaker_id": None}

    def listing(self) -> list[dict]:
        return [
            {"id": key, "language": entry["language"], "quality": entry["quality"], "rate": entry["rate"]}
            for key, entry in sorted(self.entries.items())
        ]

    def first(self, prefix: str) -> str:
        for key in sorted(self.entries):
            if key.startswith(prefix):
                return key
        return ""

    def pick(self, wanted: str, language: str) -> str:
        """The named voice if it exists and speaks the right language, else any voice that does."""
        entry = self.entries.get(wanted)
        if entry and entry["language"].startswith(language):
            return wanted
        fallback = DEFAULT_FR if language == "fr" else DEFAULT_EN
        if fallback in self.entries:
            return fallback
        return self.first("fr_" if language == "fr" else "en_") or next(iter(self.entries), "")


class Speaker:
    """
    Holds the loaded voices. Only the worker thread below ever touches this, which is deliberate:
    see Worker for why.
    """

    def __init__(self):
        self.catalogue = Catalogue()
        if not self.catalogue.entries:
            raise SystemExit(
                f"No voices in {VOICES_DIR}. Run "
                "powershell -ExecutionPolicy Bypass -File .\\piper_server\\setup.ps1 to fetch some."
            )
        self.loaded: dict[str, PiperVoice] = {}

    def voice(self, key: str) -> PiperVoice:
        """
        Loaded on first use, then kept. Loading costs a couple of seconds, and onnxruntime is slow
        for its first run or two as well, so say something here and throw it away: that way the cost
        lands at start-up, or once when a new voice is chosen, rather than inside a reply.
        """
        if key not in self.loaded:
            started = time.time()
            loaded = PiperVoice.load(self.catalogue.entries[key]["model"])
            for _ in range(2):
                list(loaded.synthesize("Bonjour."))
            self.loaded[key] = loaded
            print(f"  {key} ready in {time.time() - started:.1f}s", flush=True)
        return self.loaded[key]

    def warm(self, voices: dict[str, str] | None = None):
        """
        Loads the voices she will actually use, so the first reply is as quick as the hundredth.

        Which two those are is the app's business, not ours: it stores them in settings.json and
        names them on every request. Warming our own defaults instead was worth nothing whenever the
        app had chosen anything else - the English voice in particular, because "en_GB-alan-medium"
        sorts first and the app asks for "en_GB-cori-high". The first reply of the session then paid
        a four-second model load in the middle of it. So the app POSTs /warm with its pair at
        start-up, and this falls back to the defaults only when nobody has said.
        """
        asked = voices or {}
        for language in ("fr", "en"):
            key = self.catalogue.pick(asked.get(language, ""), language)
            if key:
                self.voice(key)

    def say(self, segments: list[dict], voices: dict[str, str], speeds: dict[str, float] | None = None) -> tuple[bytes, dict]:
        pieces: list[tuple[np.ndarray, int]] = []
        used: list[str] = []
        for segment in segments:
            key = self.catalogue.pick(voices.get(segment["lang"], ""), segment["lang"])
            if not key:
                raise RuntimeError(f"No {segment['lang']} voice is installed.")
            entry = self.catalogue.entries[key]
            config = SynthesisConfig(
                speaker_id=entry["speaker_id"],
                # Piper measures length, not speed: a bigger scale is a slower voice.
                length_scale=1.0 / speed_for(segment["lang"], speeds),
            )
            chunks = list(self.voice(key).synthesize(segment["text"], syn_config=config))
            if not chunks:
                continue
            audio = np.concatenate([c.audio_float_array for c in chunks]).astype(np.float32)
            pieces.append((audio, chunks[0].sample_rate))
            used.append(key)

        if not pieces:
            raise RuntimeError("That produced no audio.")
        rate = max(r for _, r in pieces)
        joined: list[np.ndarray] = []
        pause = np.zeros(int(rate * PAUSE_MS / 1000), dtype=np.float32)
        for audio, source in pieces:
            if joined:
                joined.append(pause)
            joined.append(resample(audio, source, rate))
        final = np.concatenate(joined)
        return pcm16_wav(final, rate), {"seconds": round(final.size / rate, 2), "rate": rate, "voices": used}


class Worker(threading.Thread):
    """
    Owns the voices: every request is handed to this one thread.

    This is not just about avoiding two replies at once. ThreadingHTTPServer runs each request on a
    fresh thread, and onnxruntime pays a setup cost the first time a session is used from a given
    thread - enough to turn a reply that takes a second and a half into one that takes seven. The
    avatar server learned the same lesson about CUDA kernels. Keeping all the work on one long-lived
    thread pays that cost once, at start-up.
    """

    def __init__(self):
        super().__init__(daemon=True)
        self.jobs: "queue.Queue[tuple]" = queue.Queue()
        self.ready = threading.Event()
        self.failure: BaseException | None = None
        self.speaker: Speaker | None = None

    def run(self):
        try:
            self.speaker = Speaker()
            self.speaker.warm()
        except BaseException as error:  # SystemExit too: missing voices must reach /health
            self.failure = error
            self.ready.set()
            return
        self.ready.set()
        while True:
            job, result, done = self.jobs.get()
            try:
                job(self.speaker, result)
            except Exception as error:
                result["error"] = error
            finally:
                done.set()

    def _run(self, job, timeout: float) -> dict:
        result: dict = {}
        done = threading.Event()
        self.jobs.put((job, result, done))
        if not done.wait(timeout):
            raise TimeoutError("The voice took too long to answer.")
        if "error" in result:
            raise result["error"]
        return result

    def speak(self, segments: list[dict], voices: dict[str, str], speeds: dict[str, float], timeout: float = 120.0) -> dict:
        def job(speaker: Speaker, result: dict):
            result["wav"], result["timings"] = speaker.say(segments, voices, speeds)

        return self._run(job, timeout)

    def warm(self, voices: dict[str, str], timeout: float = 180.0) -> dict:
        """Loads a pair of voices now, so no reply has to wait for it. Already-loaded ones cost nothing."""

        def job(speaker: Speaker, result: dict):
            speaker.warm(voices)
            result["loaded"] = sorted(speaker.loaded)

        return self._run(job, timeout)


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
        if worker.failure or not worker.speaker:
            return self._json(500, {"ok": False, "error": str(worker.failure)})
        speaker = worker.speaker
        self._json(
            200,
            {
                "ok": True,
                "voices": speaker.catalogue.listing(),
                "loaded": sorted(speaker.loaded),
                "defaults": {"fr": speaker.catalogue.pick("", "fr"), "en": speaker.catalogue.pick("", "en")},
            },
        )

    def do_POST(self):
        route = urlparse(self.path).path
        if route not in ("/speak", "/warm"):
            return self._json(404, {"error": "Not found"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return self._json(400, {"error": "Nothing to say."})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return self._json(400, {"error": "That wasn't valid JSON."})

        if route == "/warm":
            return self._warm(body)

        segments = [
            {"lang": s["lang"], "text": s["text"].strip()}
            for s in (body.get("segments") or [])
            if isinstance(s, dict) and s.get("lang") in ("fr", "en") and isinstance(s.get("text"), str) and s["text"].strip()
        ]
        if not segments:
            return self._json(400, {"error": "Nothing to say."})
        if sum(len(s["text"]) for s in segments) > MAX_CHARS:
            return self._json(413, {"error": "That reply is too long to speak."})
        asked = body.get("voices") if isinstance(body.get("voices"), dict) else {}
        voices = {lang: asked.get(lang) if isinstance(asked.get(lang), str) else "" for lang in ("fr", "en")}
        paces = body.get("speeds") if isinstance(body.get("speeds"), dict) else {}
        speeds = {lang: speed_for(lang, paces) for lang in ("fr", "en")}

        if not worker.ready.is_set():
            return self._json(503, {"error": "The voice is still warming up."})
        if worker.failure:
            return self._json(500, {"error": str(worker.failure)})

        started = time.time()
        try:
            result = worker.speak(segments, voices, speeds)
        except Exception as error:
            print(f"Speech failed: {error}", file=sys.stderr, flush=True)
            return self._json(500, {"error": f"Couldn't speak that reply: {error}"})

        wav, timings = result["wav"], result["timings"]
        took = round(time.time() - started, 2)
        pace = "/".join(f"{lang} {speeds[lang]:.2f}" for lang in ("fr", "en"))
        print(f"spoke {timings['seconds']}s in {took}s as {', '.join(timings['voices'])} at {pace}", flush=True)
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(wav)))
        self.send_header("x-speech", json.dumps({**timings, "took": took}))
        self.end_headers()
        self.wfile.write(wav)

    def _warm(self, body: dict):
        """
        Loads the pair of voices the app is configured to use. Called once when the app starts and
        again whenever the choice changes, so the cost never lands inside a reply.
        """
        asked = body.get("voices") if isinstance(body.get("voices"), dict) else {}
        voices = {lang: asked.get(lang) if isinstance(asked.get(lang), str) else "" for lang in ("fr", "en")}
        if not worker.ready.is_set():
            return self._json(503, {"error": "The voice is still warming up."})
        if worker.failure:
            return self._json(500, {"error": str(worker.failure)})
        started = time.time()
        try:
            result = worker.warm(voices)
        except Exception as error:
            print(f"Warm-up failed: {error}", file=sys.stderr, flush=True)
            return self._json(500, {"error": f"Couldn't load those voices: {error}"})
        self._json(200, {"ok": True, "loaded": result["loaded"], "took": round(time.time() - started, 2)})

    def log_message(self, format, *args):
        pass  # failures are printed above


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print("Loading Piper...", flush=True)
    worker = Worker()
    worker.start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Listening on http://127.0.0.1:{PORT}; /health says when she is ready.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
