"use client";

import type { SpeechSegment, VoiceSettings } from "@/lib/types";
import { rms, type LevelRef } from "./voice";

/**
 * Speaks a reply as video: the server makes her voice and lip-syncs her photo to it, and the
 * browser plays the one mp4 that comes back. The audio lives in that video, so nothing has to be
 * kept in sync here.
 */

// A media element can only ever have one MediaElementAudioSourceNode, so keep it with the element.
const meters = new WeakMap<HTMLVideoElement, { ctx: AudioContext; analyser: AnalyserNode }>();

function meterFor(video: HTMLVideoElement) {
  let meter = meters.get(video);
  if (!meter) {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaElementSource(video).connect(analyser);
    analyser.connect(ctx.destination);
    meter = { ctx, analyser };
    meters.set(video, meter);
  }
  return meter;
}

export async function speakWithPhoto(
  segments: SpeechSegment[],
  voice: VoiceSettings,
  level: LevelRef,
  signal: AbortSignal,
  video: HTMLVideoElement,
): Promise<void> {
  const parts = segments.filter((s) => s.text.trim());
  if (parts.length === 0 || signal.aborted) return;

  const res = await fetch("/api/avatar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ segments: parts, voice: voice.geminiVoice, model: voice.geminiModel }),
    signal,
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(problem.error ?? `The avatar couldn't be rendered (${res.status}).`);
  }
  const url = URL.createObjectURL(await res.blob());
  if (signal.aborted) {
    URL.revokeObjectURL(url);
    return;
  }

  const { ctx, analyser } = meterFor(video);
  if (ctx.state !== "running") await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1200))]);
  const samples = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let safety: ReturnType<typeof setTimeout> | undefined;

  try {
    video.src = url;
    video.currentTime = 0;
    await video.play();
    video.classList.add("is-speaking");

    const meter = () => {
      analyser.getByteTimeDomainData(samples);
      level.current = rms(samples);
      raf = requestAnimationFrame(meter);
    };
    meter();

    await new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener("abort", onAbort);
        video.removeEventListener("ended", finish);
        video.removeEventListener("error", finish);
        resolve();
      };
      const onAbort = () => {
        video.pause();
        finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      video.addEventListener("ended", finish, { once: true });
      video.addEventListener("error", finish, { once: true });
      // If the video stalls, don't leave her stuck on "Speaking".
      safety = setTimeout(finish, ((video.duration || 30) + 5) * 1000);
    });
  } finally {
    clearTimeout(safety);
    cancelAnimationFrame(raf);
    level.current = 0;
    video.classList.remove("is-speaking");
    video.pause();
    URL.revokeObjectURL(url);
  }
}
