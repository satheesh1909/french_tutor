"""Wav2Lip is from 2020. Three small fixes let it run on current numpy, librosa and torch.

Run by setup.ps1 straight after cloning it; safe to run again.
"""

import pathlib

WAV2LIP = pathlib.Path(__file__).parent / "wav2lip"


def patch(relative_path: str, pairs: list[tuple[str, str]]) -> None:
    path = WAV2LIP / relative_path
    text = path.read_text(encoding="utf-8")
    changes = 0
    for old, new in pairs:
        if new in text and old not in text:
            continue  # already applied
        if old not in text:
            raise SystemExit(f"{relative_path}: couldn't find the line to patch: {old[:60]!r}")
        text = text.replace(old, new)
        changes += 1
    path.write_text(text, encoding="utf-8")
    print(f"  {relative_path}: {changes} change(s)")


def main() -> None:
    if not WAV2LIP.exists():
        raise SystemExit(f"{WAV2LIP} doesn't exist. Clone Wav2Lip first (setup.ps1 does this).")

    # librosa made these arguments keyword-only.
    patch(
        "audio.py",
        [
            (
                "return librosa.filters.mel(hp.sample_rate, hp.n_fft, n_mels=hp.num_mels,",
                "return librosa.filters.mel(sr=hp.sample_rate, n_fft=hp.n_fft, n_mels=hp.num_mels,",
            )
        ],
    )

    # numpy removed the np.int alias.
    patch("face_detection/utils.py", [("dtype=np.int)", "dtype=int)")])

    # torch.load defaults to weights_only=True since 2.6; these checkpoints are full pickles.
    patch(
        "inference.py",
        [
            ("checkpoint = torch.load(checkpoint_path)", "checkpoint = torch.load(checkpoint_path, weights_only=False)"),
            (
                "checkpoint = torch.load(checkpoint_path,\n\t\t\t\t\t\t\t\tmap_location=lambda storage, loc: storage)",
                "checkpoint = torch.load(checkpoint_path,\n\t\t\t\t\t\t\t\tmap_location=lambda storage, loc: storage, weights_only=False)",
            ),
        ],
    )
    patch(
        "face_detection/detection/sfd/sfd_detector.py",
        [("model_weights = torch.load(path_to_detector)", "model_weights = torch.load(path_to_detector, weights_only=False)")],
    )
    print("Wav2Lip patched.")


if __name__ == "__main__":
    main()
