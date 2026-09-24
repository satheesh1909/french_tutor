#!/usr/bin/env python3
"""
fr.py - transcribe a French recording and measure how you actually spoke.

Usage:   python fr.py monologue.m4a
         python fr.py monologue.m4a large-v3     (slower, best on accented French)

Prints the transcript with every hesitation marked INSIDE the sentence where it
happened, then the numbers: pace, pause count, longest pause, share of time
silent, and any English words that slipped in. Paste the whole output into the
chat.

WHAT CHANGED (and why your last run was wrong)
----------------------------------------------
The previous version used vad_filter=False, on the theory that keeping the
silence was the only way to measure it. That was wrong, and it is what produced
the fake ending ("n'oubliez pas de vous abonner...") and the impossible
"0 pauses".

Left alone with silence, Whisper invents speech to fill it - almost always a
YouTube outro or a subtitling credit. Those invented words also carry invented
timestamps, which paper over the real gaps, so the pause count collapses to
zero.

vad_filter=True cuts the silence out BEFORE decoding, so there is nothing for
Whisper to hallucinate into - and faster-whisper then maps every word timestamp
back onto the original recording, so the gaps are still there to measure. Both,
from one pass.
"""

import os
import re
import sys

PAUSE_S = 0.6          # a gap this long between two words is a hesitation
MODEL_DEFAULT = "medium"

# Whisper guesses words from sound alone. This primes it with the vocabulary you
# actually use, which is what stops "étape" becoming "étage" and "tâche"
# becoming "tasse". Add your own project nouns and team names to the end.
VOCAB_PROMPT = (
    "Réunion de projet chez AstraZeneca. "
    "Vocabulaire : le livrable, l'échéance, la priorité, la validation, "
    "le périmètre, le jalon, la charge, l'étape, la tâche, la phase, "
    "l'équipe, le point d'attention, le relevé de décisions, la clôture, "
    "l'hypercare, l'escalade, DTU, Qube."
)

# Things Whisper says when it is making it up. Any line that is mostly one of
# these gets dropped, with a note so you know it happened.
HALLUCINATION_MARKERS = [
    "abonner", "abonnez", "notre chaîne", "sous-titres", "sous-titrage",
    "soustitreur", "amara.org", "merci d'avoir regardé", "merci à tous",
    "à la prochaine", "générique", "musique", "traduit par", "©",
]

WORD_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*")

# Common English words that show up when the French word doesn't arrive in time.
ENGLISH_TELLS = {
    "team", "meeting", "deadline", "deliverable", "issue", "actually",
    "so", "because", "but", "next", "week", "project", "task", "stage",
    "update", "review", "scope", "risk", "planning", "sorry", "okay", "ok",
}


def count_words(text):
    return len(WORD_RE.findall(text))


def looks_hallucinated(text):
    low = text.lower()
    return any(marker in low for marker in HALLUCINATION_MARKERS)


def transcribe(path, size):
    from faster_whisper import WhisperModel

    device, compute = ("cuda", "float16")
    try:
        model = WhisperModel(size, device=device, compute_type=compute)
    except Exception:
        device, compute = ("cpu", "int8")
        model = WhisperModel(size, device=device, compute_type=compute)

    segments, info = model.transcribe(
        path,
        language="fr",
        word_timestamps=True,      # gives a start and end for every word
        vad_filter=True,           # <- THE FIX: no silence to hallucinate into.
                                   #    Timestamps are still mapped back onto the
                                   #    original recording, so pauses survive.
        vad_parameters={
            "min_silence_duration_ms": 300,   # shorter than a real hesitation,
                                              # so hesitations stay measurable
            "speech_pad_ms": 200,
        },
        initial_prompt=VOCAB_PROMPT,
        condition_on_previous_text=False,     # stops one bad guess poisoning the rest
        no_speech_threshold=0.5,
        compression_ratio_threshold=2.2,      # rejects the repetitive loops
        temperature=[0.0, 0.2, 0.4],          # fall back only if decoding fails
        beam_size=5,
    )

    words, dropped = [], []
    for seg in segments:
        if looks_hallucinated(seg.text):
            dropped.append(seg.text.strip())
            continue
        for w in (seg.words or []):
            words.append((w.start, w.end, w.word))

    return words, dropped, device, getattr(info, "duration", None)


def build(words):
    """words: list of (start, end, text). Returns (lines, stats)."""
    if not words:
        return ["No speech detected."], {}

    parts, pauses = [], []
    prev_end = words[0][0]
    for start, end, text in words:
        gap = start - prev_end
        if gap >= PAUSE_S:
            pauses.append(gap)
            parts.append("  [%.1fs]  " % gap)
        parts.append(text.strip() + " ")
        prev_end = end

    flowing = "".join(parts)
    flowing = re.sub(r"(?<=[.!?…])\s+", "\n", flowing).strip()

    speech_start, speech_end = words[0][0], words[-1][1]
    duration = max(speech_end - speech_start, 0.1)
    silent = sum(pauses)
    wc = sum(count_words(t) for _, _, t in words)

    english = sorted({
        w.lower() for _, _, t in words for w in WORD_RE.findall(t)
        if w.lower() in ENGLISH_TELLS
    })

    talking = max(duration - silent, 0.1)
    stats = {
        "duration": duration,
        "words": wc,
        "pace": wc / duration * 60,
        "articulation": wc / talking * 60,
        "sentences": len([s for s in flowing.split("\n") if s.strip()]),
        "pauses": pauses,
        "silent": silent,
        "silent_pct": silent / duration * 100,
        "english": english,
    }
    return flowing.split("\n"), stats


def report(lines, st, dropped, device):
    out = ["=" * 62,
           "TRANSCRIPT   (hesitations shown as [x.xs] where they happened)",
           "=" * 62]
    out += lines
    if dropped:
        out += ["", "-- Whisper invented these and they were removed --"]
        out += ["   " + d for d in dropped]
    if not st:
        return out

    out += ["", "=" * 62, "HOW YOU SPOKE", "=" * 62]
    out.append("speaking time       %.0f s" % st["duration"])
    out.append("words               %d" % st["words"])
    out.append("pace                %.0f words/min   (silence included)"
               % st["pace"])
    out.append("while actually      %.0f words/min   (silence taken out)"
               % st["articulation"])
    out.append("                    native conversation ~140-180")
    out.append("                    the second number is your real speed;")
    out.append("                    a big gap between the two means hesitation,")
    out.append("                    not slowness")
    out.append("hesitations >=%.1fs   %d" % (PAUSE_S, len(st["pauses"])))
    if st["pauses"]:
        out.append("longest pause       %.1f s" % max(st["pauses"]))
        out.append("total silence       %.0f s  (%.0f%% of the recording)"
                   % (st["silent"], st["silent_pct"]))
    out.append("sentences           %d" % st["sentences"])
    if st["english"]:
        out.append("English words       %s" % ", ".join(st["english"]))
    else:
        out.append("English words       none")
    out.append("engine              faster-whisper on %s" % device)
    out += ["", "Paste everything above into the chat."]
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python fr.py <audio file> [small|medium|large-v3]")
        sys.exit(1)
    audio = sys.argv[1]
    if not os.path.exists(audio):
        print("Can't find that file: %s" % audio)
        sys.exit(1)
    size = sys.argv[2] if len(sys.argv) > 2 else MODEL_DEFAULT

    words, dropped, device, _ = transcribe(audio, size)
    lines, stats = build(words)
    print("\n".join(report(lines, stats, dropped, device)))
