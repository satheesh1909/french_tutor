"use client";

import type { VoiceSettings } from "@/lib/types";
import type { LevelRef } from "./voice";

/**
 * The small noise a person makes before answering.
 *
 * Even with every stage overlapped, a reply from a cloud model cannot arrive in the quarter of a
 * second a human takes, and the gap is silent - which is what makes the app feel like it has hung
 * rather than like someone thinking. A person fills that gap without trying: "mmh", "alors...". So
 * does she now.
 *
 * It is her own voice, synthesised by the same server as the rest of her speech, because a stock
 * recording spliced in front of her would sound like a second person. The phrases are fixed, so the
 * voice server caches them and they are free after the first time.
 *
 * It is cosmetic, and it is built to stay that way: every failure is swallowed, and it never delays
 * or blocks a word of the actual reply.
 */

const PHRASES = ["Mmh.", "Alors...", "Ah.", "Hm, voyons."];

/** Below this, the reply was quick enough that a thinking noise would only be in the way. */
const AFTER_MS = 380;

export interface ThinkingSound {
  /** Renders the phrases so there is nothing to wait for later. Safe to call repeatedly. */
  prepare(): void;
  /** Starts the noise unless the reply arrives first. Call once per turn, at the end of the turn. */
  schedule(): void;
  /** The reply is here, or the student spoke: stop and cancel. */
  cancel(): void;
  release(): void;
}

export function thinkingSound(voice: VoiceSettings, level: LevelRef, onSound?: () => void): ThinkingSound {
  let ctx: AudioContext | null = null;
  let buffers: (AudioBuffer | null)[] = [];
  let loading: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let playing: AudioBufferSourceNode | null = null;
  let last = -1;

  const context = (): AudioContext => (ctx ??= new AudioContext());

  const load = async (): Promise<void> => {
    const c = context();
    buffers = await Promise.all(
      PHRASES.map(async (text) => {
        try {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              segments: [{ lang: "fr", text }],
              provider: voice.provider,
              voice: voice.geminiVoice,
              model: voice.geminiModel,
              speaker: voice.xttsSpeaker,
              voices: { fr: voice.piperVoiceFr, en: voice.piperVoiceEn },
              speeds: { fr: voice.piperSpeedFr, en: voice.piperSpeedEn },
            }),
          });
          if (!res.ok) return null;
          return await c.decodeAudioData(await res.arrayBuffer());
        } catch {
          return null; // no thinking noise is better than a broken turn
        }
      }),
    );
  };

  const pick = (): AudioBuffer | null => {
    const ready = buffers.map((b, i) => [b, i] as const).filter(([b, i]) => b !== null && i !== last);
    if (ready.length === 0) return null;
    const [buffer, index] = ready[Math.floor(Math.random() * ready.length)];
    last = index;
    return buffer;
  };

  return {
    prepare() {
      loading ??= load().catch(() => undefined);
    },
    schedule() {
      this.prepare();
      clearTimeout(timer);
      timer = setTimeout(() => {
        const buffer = pick();
        const c = ctx;
        if (!buffer || !c || c.state === "closed") return;
        try {
          const source = c.createBufferSource();
          source.buffer = buffer;
          source.connect(c.destination);
          source.onended = () => {
            if (playing === source) {
              playing = null;
              level.current = 0;
            }
          };
          source.start();
          playing = source;
          level.current = 0.35; // enough for the avatar to stir, not enough to look like speech
          onSound?.();
        } catch {
          // nothing worth reporting: she simply waits in silence, as before
        }
      }, AFTER_MS);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      if (playing) {
        try {
          playing.stop();
        } catch {
          // already finished
        }
        playing = null;
        level.current = 0;
      }
    },
    release() {
      this.cancel();
      void ctx?.close().catch(() => undefined);
      ctx = null;
      buffers = [];
      loading = null;
    },
  };
}
