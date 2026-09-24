"use client";

import type { SpeechTiming } from "@/lib/fluency";

// Turns recorded audio into what the server wants: 16 kHz mono WAV (which every speech model
// accepts), plus when the student was actually talking, for measuring speaking speed.

const TARGET_SAMPLE_RATE = 16_000;
const MIN_CLIP_SEC = 0.35;
const FRAME_SEC = 0.02;

export interface RecordedClip {
  wav: Blob;
  timing: SpeechTiming;
}

/** From a MediaRecorder blob (webm/ogg). Null when too short to be speech. */
export async function clipFromBlob(blob: Blob): Promise<RecordedClip | null> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return decoded.duration < MIN_CLIP_SEC ? null : clipFromBuffer(decoded);
  } finally {
    await ctx.close();
  }
}

/** From raw microphone samples. Null when too short to be speech. */
export async function clipFromSamples(samples: Float32Array, sampleRate: number): Promise<RecordedClip | null> {
  if (samples.length / sampleRate < MIN_CLIP_SEC) return null;
  const buffer = new AudioBuffer({ length: samples.length, sampleRate, numberOfChannels: 1 });
  buffer.copyToChannel(new Float32Array(samples), 0);
  return clipFromBuffer(buffer);
}

async function clipFromBuffer(buffer: AudioBuffer): Promise<RecordedClip> {
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  return { wav: encodeWav(samples, TARGET_SAMPLE_RATE), timing: speechTiming(samples, TARGET_SAMPLE_RATE) };
}

export function concatAudio(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Finds when the student was actually talking, from the loudness of 20 ms frames. Used to
 * measure speaking speed when the local Whisper server (which gives exact word timings) isn't running.
 */
function speechTiming(samples: Float32Array, sampleRate: number): SpeechTiming {
  const frame = Math.round(sampleRate * FRAME_SEC);
  const energy: number[] = [];
  for (let i = 0; i + frame <= samples.length; i += frame) energy.push(rmsOf(samples.subarray(i, i + frame)));
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
