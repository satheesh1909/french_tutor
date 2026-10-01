"use client";

import type { SpeechSegment, VoiceSettings } from "@/lib/types";
import type { Playable, SpeechPlayer } from "./speechQueue";
import { rms, type LevelRef } from "./voice";

/**
 * Speaks a reply as video: the server makes her voice and lip-syncs her photo to it, and the browser
 * plays the mp4 that comes back. The audio lives in that video, so nothing has to be kept in sync
 * here.
 *
 * One clip per sentence rather than one per reply, so she starts talking as soon as the first sentence
 * has been rendered instead of the last. Between clips the element holds its final frame, so the
 * join reads as a small pause rather than a cut back to the still.
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

export function photoPlayer(voice: VoiceSettings, level: LevelRef, video: HTMLVideoElement): SpeechPlayer {
  return {
    async render(segment: SpeechSegment, signal: AbortSignal): Promise<Playable> {
      const res = await fetch("/api/avatar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: [segment], voice: voice.geminiVoice, model: voice.geminiModel }),
        signal,
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(problem.error ?? `The avatar couldn't be rendered (${res.status}).`);
      }
      const url = URL.createObjectURL(await res.blob());
      return {
        play: () => playClip(video, url, level, signal),
        release: () => URL.revokeObjectURL(url),
      };
    },
    release() {
      video.classList.remove("is-speaking");
      video.pause();
    },
  };
}

async function playClip(video: HTMLVideoElement, url: string, level: LevelRef, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const { ctx, analyser } = meterFor(video);
  if (ctx.state !== "running") await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1200))]);
  if (signal.aborted) return;

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
  }
}
