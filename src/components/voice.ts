"use client";

import type { Lang, SpeechSegment, VoiceProvider } from "@/lib/types";

/** Current loudness (0–1) of whoever is talking; the avatar reads it every frame. */
export type LevelRef = { current: number };

export function rms(samples: Uint8Array): number {
  let sum = 0;
  for (const v of samples) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/** Speaks the tutor's reply. Falls back to the browser's built-in voices if Gemini is unavailable. */
export async function speak(segments: SpeechSegment[], provider: VoiceProvider, level: LevelRef, signal: AbortSignal): Promise<void> {
  const parts = segments.filter((s) => s.text.trim());
  if (parts.length === 0 || signal.aborted) return;
  if (provider === "gemini") {
    try {
      await speakWithGemini(parts, level, signal);
      return;
    } catch (err) {
      if (signal.aborted) return;
      console.warn("Gemini voice failed; using the browser voice instead.", err);
    }
  }
  await speakWithBrowser(parts, level, signal);
}

async function speakWithGemini(segments: SpeechSegment[], level: LevelRef, signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ segments }),
    signal,
  });
  if (!res.ok) throw new Error(`Voice request failed (${res.status})`);
  const audio = await res.arrayBuffer();
  if (signal.aborted) return;

  const ctx = new AudioContext();
  let raf = 0;
  let safety: ReturnType<typeof setTimeout> | undefined;
  try {
    // Browsers may hold audio until the page has been interacted with; don't wait forever for that.
    if (ctx.state !== "running") {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
      if ((ctx.state as AudioContextState) !== "running") throw new Error("Audio playback is blocked by the browser.");
    }
    const buffer = await ctx.decodeAudioData(audio);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const samples = new Uint8Array(analyser.fftSize);
    const meter = () => {
      analyser.getByteTimeDomainData(samples);
      level.current = rms(samples);
      raf = requestAnimationFrame(meter);
    };
    await new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        source.stop();
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      source.onended = finish;
      // If the audio device stalls, "ended" may never fire; don't leave the tutor stuck on "Speaking".
      safety = setTimeout(finish, (buffer.duration + 2) * 1000);
      source.start();
      meter();
    });
  } finally {
    clearTimeout(safety);
    cancelAnimationFrame(raf);
    level.current = 0;
    await ctx.close();
  }
}

// Windows/Edge voices first (the "Online (Natural)" ones sound good), then common macOS/Chrome ones.
const PREFERRED_VOICES: Record<Lang, string[]> = {
  en: ["Sonia", "Libby", "Maisie", "Serena", "Kate", "Google UK English Female"],
  fr: ["Denise", "Vivienne", "Eloise", "Amélie", "Audrey", "Google français"],
};

function pickVoice(voices: SpeechSynthesisVoice[], lang: Lang): SpeechSynthesisVoice | undefined {
  const locale = lang === "en" ? "en-gb" : "fr-fr";
  const local = voices.filter((v) => v.lang.replace("_", "-").toLowerCase() === locale);
  for (const name of PREFERRED_VOICES[lang]) {
    const match = local.find((v) => v.name.includes(name));
    if (match) return match;
  }
  return local.find((v) => /natural|online/i.test(v.name)) ?? local[0] ?? voices.find((v) => v.lang.startsWith(lang));
}

function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const voices = synth.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(synth.getVoices()), 1500);
    synth.addEventListener(
      "voiceschanged",
      () => {
        clearTimeout(timer);
        resolve(synth.getVoices());
      },
      { once: true },
    );
  });
}

async function speakWithBrowser(segments: SpeechSegment[], level: LevelRef, signal: AbortSignal): Promise<void> {
  if (!("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  const voices = await loadVoices(synth);
  // Browser speech exposes no audio stream, so animate the avatar with a gentle pulse instead.
  const pulse = setInterval(() => {
    level.current = 0.2 + Math.random() * 0.45;
  }, 120);
  try {
    for (const segment of segments) {
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(segment.text);
        utterance.lang = segment.lang === "fr" ? "fr-FR" : "en-GB";
        const voice = pickVoice(voices, segment.lang);
        if (voice) utterance.voice = voice;
        utterance.rate = segment.lang === "fr" ? 0.92 : 1;
        // Speech synthesis can silently never start (e.g. before any page interaction); cap the wait.
        const safety = setTimeout(() => done(), 3000 + segment.text.length * 120);
        const cancel = () => {
          clearTimeout(safety);
          synth.cancel();
          resolve();
        };
        const done = () => {
          clearTimeout(safety);
          signal.removeEventListener("abort", cancel);
          resolve();
        };
        utterance.onend = done;
        utterance.onerror = done;
        signal.addEventListener("abort", cancel, { once: true });
        synth.speak(utterance);
      });
    }
  } finally {
    clearInterval(pulse);
    level.current = 0;
  }
}
