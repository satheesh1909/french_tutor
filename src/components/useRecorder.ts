"use client";

import { useCallback, useRef, useState } from "react";
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
  const stop = useCallback(async (): Promise<Blob | null> => {
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

async function toWav(blob: Blob): Promise<Blob | null> {
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
    return encodeWav(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
  } finally {
    await ctx.close();
  }
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
