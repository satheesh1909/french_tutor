"use client";

import { useCallback, useRef, useState } from "react";
import { clipFromBlob, type RecordedClip } from "./audioClip";
import { rms, type LevelRef } from "./voice";

/** Push-to-talk recording (used when hands-free mode is off). */
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
    return clipFromBlob(new Blob(state.chunks, { type: state.recorder.mimeType }));
  }, [level]);

  const isRecording = useCallback(() => live.current !== null, []);

  return { recording, start, stop, isRecording };
}
