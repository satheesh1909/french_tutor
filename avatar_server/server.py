"""Local lip-sync server for the French tutor.

Takes Charlotte's spoken audio and a still photo of her, and returns a short video of that photo
speaking, using Wav2Lip on the GPU. Start it with:

    npm run avatar        (or: avatar_server/.venv/Scripts/python avatar_server/server.py)

The heavy work happens once, at start-up: the model loads and each face is measured and cached.
While she talks, only the mel-spectrogram, the frame generation and the encode are on the clock,
which together run several times faster than real time.

Environment variables:
    AVATAR_PORT     port to listen on (default 8766)
    AVATAR_FACE     default face name (default "charlotte")
    AVATAR_DEVICE   "auto", "cuda" or "cpu" (default "auto")
    AVATAR_FPS      frames per second to render (default 25)
"""

import io
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE / "wav2lip"))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

import audio as w2l_audio  # noqa: E402  (wav2lip/audio.py)
import face_detection  # noqa: E402
from models import Wav2Lip  # noqa: E402

PORT = int(os.environ.get("AVATAR_PORT", "8766"))
DEFAULT_FACE = os.environ.get("AVATAR_FACE", "charlotte")
DEVICE = os.environ.get("AVATAR_DEVICE", "auto")
FPS = int(os.environ.get("AVATAR_FPS", "25"))
MAX_BYTES = 24 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
FACE_NAME = re.compile(r"^[\w-]{1,60}$")
# What a JPEG and a PNG start with. Checked so a file that isn't a photo is refused here, rather
# than being written to the faces folder for the next start-up to trip over.
MAGIC = ((b"\xff\xd8\xff", ".jpg"), (b"\x89PNG\r\n\x1a\n", ".png"))

FACES_DIR = HERE / "faces"
CHECKPOINT = HERE / "wav2lip" / "checkpoints" / "wav2lip_gan.pth"
IMG_SIZE = 96
MEL_STEP = 16
BATCH = 64  # every forward uses exactly this shape; see _generate
CHIN_PAD = 12  # a little extra room below the mouth, so the jaw can open


def ffmpeg_exe() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def pick_device() -> str:
    if DEVICE != "auto":
        return DEVICE
    return "cuda" if torch.cuda.is_available() else "cpu"


class Face:
    """A photo, with the mouth region already located."""

    def __init__(self, name: str, path: Path, detector):
        self.name = name
        self.path = path
        self.frame = cv2.imread(str(path))
        if self.frame is None:
            raise ValueError(f"Couldn't read {path}")
        self.height, self.width = self.frame.shape[:2]
        self.box = self._locate(detector)
        x1, y1, x2, y2 = self.box
        self.crop = cv2.resize(self.frame[y1:y2, x1:x2], (IMG_SIZE, IMG_SIZE))

    def _locate(self, detector):
        """Face detection takes about 15 seconds, so remember it next to the photo."""
        cache = self.path.with_suffix(".box.json")
        if cache.exists():
            saved = json.loads(cache.read_text())
            if saved.get("size") == [self.width, self.height]:
                return tuple(saved["box"])
        found = detector.get_detections_for_batch(np.array([self.frame]))[0]
        if found is None:
            raise ValueError(f"No face found in {self.path.name}")
        x1, y1, x2, y2 = found
        box = (max(0, x1), max(0, y1), min(self.width, x2), min(self.height, y2 + CHIN_PAD))
        cache.write_text(json.dumps({"box": list(box), "size": [self.width, self.height]}))
        return box


def image_suffix(image: bytes) -> str | None:
    for magic, suffix in MAGIC:
        if image.startswith(magic):
            return suffix
    return None


class Renderer:
    def __init__(self):
        self.device = pick_device()
        self.model = self._load_model()
        self.detector = face_detection.FaceAlignment(face_detection.LandmarksType._2D, flip_input=False, device=self.device)
        self.faces: dict[str, Face] = {}
        for path in sorted(FACES_DIR.glob("*.jpg")) + sorted(FACES_DIR.glob("*.png")):
            try:
                self.faces[path.stem] = Face(path.stem, path, self.detector)
                print(f"  face '{path.stem}' ready ({self.faces[path.stem].width}x{self.faces[path.stem].height})", flush=True)
            except Exception as error:
                print(f"  skipping {path.name}: {error}", file=sys.stderr, flush=True)
        if not self.faces:
            raise SystemExit(f"No usable photos in {FACES_DIR}. Put a front-facing portrait there.")

    def add_face(self, name: str, image: bytes) -> dict:
        """
        Takes a new portrait while the server is running, so her photo can be changed without a
        restart. Finding the face in it is the slow part - about fifteen seconds - and it happens
        here, on the thread that owns the detector.

        A photo that no face can be found in leaves nothing behind: the previous one is put back.
        """
        suffix = image_suffix(image)
        if suffix is None:
            raise ValueError("That file isn't a JPEG or a PNG.")
        path = FACES_DIR / f"{name}{suffix}"
        cache = path.with_suffix(".box.json")
        previous = path.read_bytes() if path.exists() else None

        path.write_bytes(image)
        # The measured box is remembered against the photo's dimensions alone, so a replacement that
        # happened to be the same size would inherit the old mouth position. Always measure again.
        cache.unlink(missing_ok=True)
        try:
            face = Face(name, path, self.detector)
        except Exception:
            cache.unlink(missing_ok=True)
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(previous)
            raise

        # The same name arriving as a .png when it was a .jpg would otherwise leave two files behind.
        for other in FACES_DIR.glob(f"{name}.*"):
            if other != path and other != cache:
                other.unlink(missing_ok=True)
        self.faces[name] = face
        print(f"  face '{name}' ready ({face.width}x{face.height})", flush=True)
        return {"name": name, "width": face.width, "height": face.height, "faces": sorted(self.faces)}

    def remove_face(self, name: str) -> dict:
        """
        Forgets a portrait and deletes its files.

        The last one is always kept. A renderer with no faces has nothing to answer with, and the
        moment to discover that is not halfway through a reply.
        """
        if name not in self.faces:
            raise ValueError(f"There is no photo called {name}.")
        if len(self.faces) == 1:
            raise ValueError("That is the only photo she has. Add another one before removing this.")
        for path in FACES_DIR.glob(f"{name}.*"):
            path.unlink(missing_ok=True)
        del self.faces[name]
        print(f"  face '{name}' removed", flush=True)
        return {"name": name, "faces": sorted(self.faces)}

    def _load_model(self):
        checkpoint = torch.load(CHECKPOINT, map_location=self.device, weights_only=False)
        model = Wav2Lip()
        model.load_state_dict({k.replace("module.", ""): v for k, v in checkpoint["state_dict"].items()})
        return model.to(self.device).eval()

    def warm(self):
        """
        The first forward at a given tensor shape takes about a minute on this GPU (kernel
        compilation), and 0.2s afterwards. So every batch is padded to exactly BATCH frames, and
        that one shape is paid for here, at start-up, instead of in front of the student.
        """
        face = next(iter(self.faces.values()))
        start = time.time()
        self._forward(face, [np.zeros((80, MEL_STEP), dtype=np.float32)] * BATCH)
        print(f"  warmed up in {time.time() - start:.0f}s", flush=True)

    def _mel_chunks(self, mel):
        chunks = []
        step = 80.0 / FPS
        i = 0
        while True:
            start = int(i * step)
            if start + MEL_STEP > mel.shape[1]:
                chunks.append(mel[:, mel.shape[1] - MEL_STEP :])
                break
            chunks.append(mel[:, start : start + MEL_STEP])
            i += 1
        return chunks

    def _forward(self, face: Face, batch: list) -> np.ndarray:
        """One full-size batch. Short batches are padded by the caller, never resized."""
        img = np.tile(face.crop, (BATCH, 1, 1, 1)).astype(np.float32)
        masked = img.copy()
        masked[:, IMG_SIZE // 2 :] = 0
        img = np.concatenate((masked, img), axis=3) / 255.0
        img_t = torch.FloatTensor(np.ascontiguousarray(np.transpose(img, (0, 3, 1, 2)))).to(self.device)
        mel_t = torch.FloatTensor(np.ascontiguousarray(np.transpose(np.asarray(batch)[..., np.newaxis], (0, 3, 1, 2)))).to(self.device)
        with torch.no_grad():
            pred = self.model(mel_t, img_t)
        return pred.cpu().numpy().transpose(0, 2, 3, 1) * 255.0

    def _generate(self, face: Face, mel):
        chunks = self._mel_chunks(mel)
        mouths = []
        for start in range(0, len(chunks), BATCH):
            batch = chunks[start : start + BATCH]
            wanted = len(batch)
            if wanted < BATCH:  # pad with the last chunk, then drop the extra frames
                batch = batch + [batch[-1]] * (BATCH - wanted)
            mouths.append(self._forward(face, batch)[:wanted])
        return np.concatenate(mouths) if mouths else np.empty((0, IMG_SIZE, IMG_SIZE, 3))

    def render(self, wav_bytes: bytes, face_name: str) -> tuple[bytes, dict]:
        face = self.faces.get(face_name) or self.faces[DEFAULT_FACE if DEFAULT_FACE in self.faces else next(iter(self.faces))]
        timings = {}

        start = time.time()
        import soundfile as sf

        samples, rate = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if rate != 16000:
            import librosa

            samples = librosa.resample(samples, orig_sr=rate, target_sr=16000)
        mel = w2l_audio.melspectrogram(samples)
        if np.isnan(mel).any():
            raise ValueError("The audio produced an empty spectrogram.")
        timings["mel"] = round(time.time() - start, 3)

        start = time.time()
        mouths = self._generate(face, mel)
        timings["frames"] = round(time.time() - start, 3)

        start = time.time()
        x1, y1, x2, y2 = face.box
        video = self._encode(face, mouths, (x1, y1, x2, y2), wav_bytes)
        timings["encode"] = round(time.time() - start, 3)
        timings["count"] = len(mouths)
        timings["seconds"] = round(len(mouths) / FPS, 2)
        timings["face"] = face.name
        return video, timings

    def _encode(self, face: Face, mouths, box, wav_bytes: bytes) -> bytes:
        """Pipes the finished frames straight into ffmpeg, with her voice muxed in."""
        x1, y1, x2, y2 = box
        audio_path = HERE / "out" / f"tmp_{threading.get_ident()}.wav"
        video_path = HERE / "out" / f"tmp_{threading.get_ident()}.mp4"
        audio_path.parent.mkdir(exist_ok=True)
        audio_path.write_bytes(wav_bytes)
        command = [
            ffmpeg_exe(), "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{face.width}x{face.height}", "-r", str(FPS), "-i", "-",
            "-i", str(audio_path),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart",
            str(video_path),
        ]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for mouth in mouths:
                frame = face.frame.copy()
                frame[y1:y2, x1:x2] = cv2.resize(mouth.astype(np.uint8), (x2 - x1, y2 - y1))
                process.stdin.write(frame.tobytes())
            process.stdin.close()
            code = process.wait(timeout=120)
            if code != 0:
                raise RuntimeError(process.stderr.read().decode("utf-8", "replace")[:400])
            return video_path.read_bytes()
        finally:
            for path in (audio_path, video_path):
                path.unlink(missing_ok=True)


class Worker(threading.Thread):
    """
    Owns the GPU. Every request is handed to this one thread, because the first frame batch on a
    thread costs about a minute of kernel compilation and then 0.2s a batch: paying that once, at
    start-up, is the difference between a usable avatar and an unusable one. It also means two
    replies can never fight over the GPU.
    """

    def __init__(self):
        super().__init__(daemon=True)
        self.jobs: "queue.Queue[tuple]" = queue.Queue()
        self.ready = threading.Event()
        self.failure: Exception | None = None
        self.renderer: Renderer | None = None

    def run(self):
        try:
            self.renderer = Renderer()
            self.renderer.warm()
        except Exception as error:
            self.failure = error
            self.ready.set()
            return
        self.ready.set()
        print(f"Avatar ready on http://127.0.0.1:{PORT} ({self.renderer.device}, faces: {', '.join(sorted(self.renderer.faces))}).", flush=True)
        while True:
            job, result, done = self.jobs.get()
            try:
                result.update(job(self.renderer))
            except Exception as error:
                result["error"] = error
            finally:
                done.set()

    def _run(self, job, timeout: float, slow: str) -> dict:
        result: dict = {}
        done = threading.Event()
        self.jobs.put((job, result, done))
        if not done.wait(timeout):
            raise TimeoutError(slow)
        if "error" in result:
            raise result["error"]
        return result

    def animate(self, wav: bytes, face: str, timeout: float = 180.0) -> dict:
        def job(renderer):
            video, timings = renderer.render(wav, face)
            return {"video": video, "timings": timings}

        return self._run(job, timeout, "The avatar took too long to answer.")

    def add_face(self, name: str, image: bytes, timeout: float = 120.0) -> dict:
        return self._run(lambda renderer: renderer.add_face(name, image), timeout, "Finding the face took too long.")

    def remove_face(self, name: str, timeout: float = 30.0) -> dict:
        # Through the queue like everything else, so a photo cannot be forgotten mid-render.
        return self._run(lambda renderer: renderer.remove_face(name), timeout, "Removing the photo took too long.")


class Handler(BaseHTTPRequestHandler):
    def _add_face(self, url):
        name = parse_qs(url.query).get("name", [""])[0].strip()
        if not FACE_NAME.match(name):
            return self._json(400, {"error": "A photo's name may only use letters, digits, dashes and underscores."})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return self._json(400, {"error": "No photo was sent."})
        if length > MAX_IMAGE_BYTES:
            return self._json(413, {"error": "That photo is too large. Keep it under 12 MB."})
        image = self.rfile.read(length)
        if image_suffix(image) is None:
            return self._json(400, {"error": "That file isn't a JPEG or a PNG."})
        if not worker.ready.is_set():
            return self._json(503, {"error": "The avatar is still warming up."})

        started = time.time()
        try:
            added = worker.add_face(name, image)
        except Exception as error:
            print(f"Couldn't add face '{name}': {error}", file=sys.stderr, flush=True)
            return self._json(400, {"error": str(error)})
        print(f"added face '{name}' in {round(time.time() - started, 1)}s", flush=True)
        self._json(200, added)

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
        if worker.failure or not worker.renderer:
            return self._json(500, {"ok": False, "error": str(worker.failure)})
        self._json(200, {"ok": True, "device": worker.renderer.device, "faces": sorted(worker.renderer.faces), "fps": FPS})

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path != "/faces":
            return self._json(404, {"error": "Not found"})
        name = parse_qs(url.query).get("name", [""])[0].strip()
        if not FACE_NAME.match(name):
            return self._json(400, {"error": "That is not a photo name."})
        if not worker.ready.is_set():
            return self._json(503, {"error": "The avatar is still warming up."})
        try:
            return self._json(200, worker.remove_face(name))
        except Exception as error:
            return self._json(400, {"error": str(error)})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/faces":
            return self._add_face(url)
        if url.path != "/animate":
            return self._json(404, {"error": "Not found"})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return self._json(400, {"error": "No audio was sent."})
        if length > MAX_BYTES:
            return self._json(413, {"error": "That reply is too long to animate."})
        wav = self.rfile.read(length)
        face = parse_qs(url.query).get("face", [DEFAULT_FACE])[0]

        if not worker.ready.is_set():
            return self._json(503, {"error": "The avatar is still warming up."})
        started = time.time()
        try:
            result = worker.animate(wav, face)
            video, timings = result["video"], result["timings"]
        except Exception as error:
            print(f"Animation failed: {error}", file=sys.stderr, flush=True)
            return self._json(500, {"error": f"Couldn't animate that reply: {error}"})

        print(f"animated {timings['seconds']}s of speech in {round(time.time() - started, 2)}s {timings}", flush=True)
        self.send_response(200)
        self.send_header("content-type", "video/mp4")
        self.send_header("content-length", str(len(video)))
        self.send_header("x-render", json.dumps(timings))
        self.end_headers()
        self.wfile.write(video)

    def log_message(self, format, *args):
        pass  # failures are printed above


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print("Loading the lip-sync model (about a minute: measuring each photo and warming the GPU)...", flush=True)
    worker = Worker()
    worker.start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Listening on http://127.0.0.1:{PORT}; /health says when she is ready.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
