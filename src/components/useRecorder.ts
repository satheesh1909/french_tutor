"use client";

import { useCallback, useRef, useState } from "react";
import type { SpeechTiming } from "@/lib/fluency";
import { rms, type LevelRef } from "./voice";

const TARGET_SAMPLE_RATE = 16_000;

/**
 * Records the microphone and returns 16 kHz mono WAV, which every speech model accepts
 * (browsers otherwise record webm or ogg depending on the vendor).
 */
export function useRecorder(level: LevelRef) {
  const [recording, setRecording] = useState(false);
  const live = useRef<{ stream: MediaStream; recorder: MediaRecorder; chunks: Blob[]; ctx: AudioContext; raf: number } | null>(null);

  const start = useCallback(async () => {
    if (live.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.start();

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const state = { stream, recorder, chunks, ctx, raf: 0 };
    const meter = () => {
      analyser.getByteTimeDomainData(samples);
      level.current = rms(samples);
      state.raf = requestAnimationFrame(meter);
    };
    meter();
    live.current = state;
    setRecording(true);
  }, [level]);

  /** Resolves to null when the clip is too short to be speech. */
  const stop = useCallback(async (): Promise<RecordedClip | null> => {
    const state = live.current;
    if (!state) return null;
    live.current = null;
    const stopped = new Promise<void>((resolve) => state.recorder.addEventListener("stop", () => resolve(), { once: true }));
    state.recorder.stop();
    await stopped;
    state.stream.getTracks().forEach((t) => t.stop());
    cancelAnimationFrame(state.raf);
    level.current = 0;
    await state.ctx.close();
    setRecording(false);
    return toWav(new Blob(state.chunks, { type: state.recorder.mimeType }));
  }, [level]);

  const isRecording = useCallback(() => live.current !== null, []);

  return { recording, start, stop, isRecording };
}

export interface RecordedClip {
  wav: Blob;
  timing: SpeechTiming;
}

async function toWav(blob: Blob): Promise<RecordedClip | null> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration < 0.35) return null;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    return { wav: encodeWav(samples, TARGET_SAMPLE_RATE), timing: speechTiming(samples, TARGET_SAMPLE_RATE) };
  } finally {
    await ctx.close();
  }
}

const FRAME_SEC = 0.02;

/**
 * Finds when the student was actually talking, from the loudness of 20 ms frames. Used to
 * measure speaking speed when the local Whisper server (which gives exact word timings) isn't running.
 */
function speechTiming(samples: Float32Array, sampleRate: number): SpeechTiming {
  const frame = Math.round(sampleRate * FRAME_SEC);
  const energy: number[] = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
    energy.push(Math.sqrt(sum / frame));
  }
  const durationSec = samples.length / sampleRate;
  // Speech is well above the room's background level (estimated from the quietest frames).
  const floor = [...energy].sort((a, b) => a - b)[Math.floor(energy.length * 0.1)] ?? 0;
  const threshold = Math.max(floor * 3, 0.015);

  const runs: [number, number][] = [];
  energy.forEach((e, i) => {
    if (e <= threshold) return;
    const last = runs.at(-1);
    // Gaps under 150 ms are just consonants and breaths inside a phrase, not pauses.
    if (last && i - last[1] <= Math.round(0.15 / FRAME_SEC)) last[1] = i;
    else runs.push([i, i]);
  });
  const voiced = runs.filter(([a, b]) => (b - a + 1) * FRAME_SEC >= 0.1); // ignore clicks
  if (voiced.length === 0) return { durationSec, startSec: 0, endSec: 0, pausesSec: [] };

  const pausesSec = voiced.slice(1).map(([start], i) => (start - voiced[i][1] - 1) * FRAME_SEC);
  return { durationSec, startSec: voiced[0][0] * FRAME_SEC, endSec: (voiced[voiced.length - 1][1] + 1) * FRAME_SEC, pausesSec };
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
