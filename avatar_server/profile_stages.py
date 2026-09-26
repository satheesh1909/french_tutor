"""Times each stage of the lip-sync pipeline separately.

The point: in a long-running server the model load and the face detection happen once, at startup.
Only the per-utterance work (mel, forward passes, encode) is on the critical path when she speaks.
"""
import sys
import time
import pathlib

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE / "wav2lip"))

import cv2
import numpy as np
import torch

import audio  # noqa: E402  (from wav2lip/)
import face_detection  # noqa: E402
from models import Wav2Lip  # noqa: E402

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
IMG_SIZE = 96
MEL_STEP = 16
FPS = 25


def stage(label, fn):
    torch.cuda.synchronize() if DEVICE == "cuda" else None
    start = time.time()
    value = fn()
    torch.cuda.synchronize() if DEVICE == "cuda" else None
    print(f"{label:<34} {time.time() - start:7.2f}s")
    return value


def load_model(path):
    model = Wav2Lip()
    checkpoint = torch.load(path, map_location=DEVICE, weights_only=False)
    model.load_state_dict({k.replace("module.", ""): v for k, v in checkpoint["state_dict"].items()})
    return model.to(DEVICE).eval()


def main():
    face_path = sys.argv[1] if len(sys.argv) > 1 else str(HERE / "faces/charlotte_512.jpg")
    wav_path = sys.argv[2] if len(sys.argv) > 2 else str(HERE / "out/charlotte.wav")

    print(f"device: {DEVICE}  face: {pathlib.Path(face_path).name}\n--- one-off, at server start ---")
    model = stage("load wav2lip checkpoint", lambda: load_model(str(HERE / "wav2lip/checkpoints/wav2lip_gan.pth")))
    detector = stage(
        "load face detector",
        lambda: face_detection.FaceAlignment(face_detection.LandmarksType._2D, flip_input=False, device=DEVICE),
    )
    frame = cv2.imread(face_path)
    box = stage("detect the face (once per photo)", lambda: detector.get_detections_for_batch(np.array([frame]))[0])
    x1, y1, x2, y2 = box
    y2 = min(frame.shape[0], y2 + 12)
    face = cv2.resize(frame[y1:y2, x1:x2], (IMG_SIZE, IMG_SIZE))

    print("--- per utterance, while she speaks ---")
    wav = stage("load + mel the audio", lambda: audio.melspectrogram(audio.load_wav(wav_path, 16000)))
    mel = wav
    seconds = mel.shape[1] / 80.0

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

    img_batch = np.tile(face, (len(chunks), 1, 1, 1)).astype(np.float32)
    masked = img_batch.copy()
    masked[:, IMG_SIZE // 2 :] = 0
    img_batch = np.concatenate((masked, img_batch), axis=3) / 255.0
    mel_batch = np.asarray(chunks)[..., np.newaxis]

    img_t = torch.FloatTensor(np.transpose(img_batch, (0, 3, 1, 2))).to(DEVICE)
    mel_t = torch.FloatTensor(np.transpose(mel_batch, (0, 3, 1, 2))).to(DEVICE)

    def forward():
        with torch.no_grad():
            return model(mel_t, img_t)

    forward()  # warm the kernels
    pred = stage(f"generate {len(chunks)} frames ({seconds:.1f}s of speech)", forward)

    def compose():
        out = pred.cpu().numpy().transpose(0, 2, 3, 1) * 255.0
        target = frame.copy()
        frames = []
        for p in out:
            f = target.copy()
            f[y1:y2, x1:x2] = cv2.resize(p.astype(np.uint8), (x2 - x1, y2 - y1))
            frames.append(f)
        return frames

    frames = stage("paste the mouth back into the photo", compose)

    def encode():
        writer = cv2.VideoWriter(str(HERE / "out/profile.avi"), cv2.VideoWriter_fourcc(*"MJPG"), FPS, (frame.shape[1], frame.shape[0]))
        for f in frames:
            writer.write(f)
        writer.release()

    stage("encode the video", encode)
    print(f"\nspeech: {seconds:.1f}s, frames: {len(chunks)}")


if __name__ == "__main__":
    main()
