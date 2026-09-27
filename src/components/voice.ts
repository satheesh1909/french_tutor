"use client";

import type { Lang, SpeechSegment, VoiceSettings } from "@/lib/types";

/** Current loudness (0–1) of whoever is talking; the avatar reads it every frame. */
export type LevelRef = {
  current: number;
  /** How far the mouth should open (0-1). Set while the tutor speaks, for lip-sync. */
  open?: number;
  /** Mouth shape: 0 is round like "ooh", 1 is wide like "eee". */
  wide?: number;
};

/** Loudness of a block of samples, 0-1, scaled so ordinary speech fills the meter. */
export function rms(samples: Uint8Array): number {
  return Math.min(1, rawRms(samples) * 4);
}

function rawRms(samples: Uint8Array): number {
  let sum = 0;
  for (const v of samples) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.sqrt(sum / samples.length);
}

/** Speaks the tutor's reply, falling back to the browser's own voices if the chosen one fails. */
export async function speak(segments: SpeechSegment[], voice: VoiceSettings, level: LevelRef, signal: AbortSignal): Promise<void> {
  const parts = segments.filter((s) => s.text.trim());
  if (parts.length === 0 || signal.aborted) return;
  if (voice.provider !== "browser") {
    try {
      await speakFromServer(parts, voice, level, signal);
      return;
    } catch (err) {
      if (signal.aborted) return;
      // Better a plainer voice than silence: a used-up quota or a stopped voice server
      // shouldn't end the lesson.
      console.warn(`The ${voice.provider} voice failed; using the browser voice instead.`, err);
    }
  }
  await speakWithBrowser(parts, voice, level, signal);
}

/** Her voice made on the server - Gemini, or the local XTTS server - and played here. */
async function speakFromServer(segments: SpeechSegment[], voice: VoiceSettings, level: LevelRef, signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      segments,
      provider: voice.provider,
      voice: voice.geminiVoice,
      model: voice.geminiModel,
      speaker: voice.xttsSpeaker,
      voices: { fr: voice.piperVoiceFr, en: voice.piperVoiceEn },
    }),
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
    const spectrum = new Uint8Array(analyser.frequencyBinCount);
    // Which bins carry the vowel's body, and which carry the brightness that tells "eee" from "ooh".
    const binHz = ctx.sampleRate / analyser.fftSize;
    const band = (from: number, to: number) => {
      let sum = 0;
      for (let i = Math.max(1, Math.round(from / binHz)); i < Math.min(spectrum.length, Math.round(to / binHz)); i++) sum += spectrum[i];
      return sum;
    };
    const meter = () => {
      analyser.getByteTimeDomainData(samples);
      analyser.getByteFrequencyData(spectrum);
      const raw = rawRms(samples);
      const low = band(120, 900);
      const high = band(1600, 4200);
      const brightness = high / (low + high + 1);
      level.current = Math.min(1, raw * 4);
      // Lower gain than the meter: a mouth that is wide open on every syllable looks like a puppet.
      level.open = Math.min(1, raw * 2.4);
      level.wide = Math.min(1, Math.max(0, (brightness - 0.25) / 0.35));
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
    level.open = 0;
    await ctx.close();
  }
}

// Windows/Edge voices first (the "Online (Natural)" ones sound good), then common macOS/Chrome ones.
const PREFERRED_VOICES: Record<Lang, string[]> = {
  en: ["Sonia", "Libby", "Maisie", "Serena", "Kate", "Google UK English Female"],
  fr: ["Denise", "Vivienne", "Eloise", "Amélie", "Audrey", "Google français"],
};

function pickVoice(voices: SpeechSynthesisVoice[], lang: Lang, chosen: string): SpeechSynthesisVoice | undefined {
  const picked = chosen && voices.find((v) => v.name === chosen);
  if (picked) return picked;
  const locale = lang === "en" ? "en-gb" : "fr-fr";
  const local = voices.filter((v) => v.lang.replace("_", "-").toLowerCase() === locale);
  for (const name of PREFERRED_VOICES[lang]) {
    const match = local.find((v) => v.name.includes(name));
    if (match) return match;
  }
  return local.find((v) => /natural|online/i.test(v.name)) ?? local[0] ?? voices.find((v) => v.lang.startsWith(lang));
}

export function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
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

async function speakWithBrowser(segments: SpeechSegment[], settings: VoiceSettings, level: LevelRef, signal: AbortSignal): Promise<void> {
  if (!("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  const voices = await loadVoices(synth);
  // Browser speech exposes no audio stream, so animate the avatar with a gentle pulse instead.
  const pulse = setInterval(() => {
    level.current = 0.2 + Math.random() * 0.45;
    level.open = level.current;
    level.wide = 0.25 + Math.random() * 0.5;
  }, 120);
  try {
    for (const segment of segments) {
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(segment.text);
        utterance.lang = segment.lang === "fr" ? "fr-FR" : "en-GB";
        const voice = pickVoice(voices, segment.lang, segment.lang === "fr" ? settings.browserVoiceFr : settings.browserVoiceEn);
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
    level.open = 0;
  }
}
