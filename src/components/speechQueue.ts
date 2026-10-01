"use client";

import type { SpeechSegment } from "@/lib/types";

/**
 * Speaks a reply sentence by sentence, making each one while the one before it is still being heard.
 *
 * Her reply used to be made in a single piece: every segment synthesised, and lip-synced, before the
 * first sound came out. Three segments is the usual number, so most of that work was finished long
 * before it was needed. Now each segment is started as soon as it exists - which, while she is still
 * writing the reply, means the student hears the opening words while the rest is being thought of.
 */

/** One rendered segment, ready to be heard. */
export interface Playable {
  play(): Promise<void>;
  /** Frees whatever holding it cost - a blob URL, usually. */
  release(): void;
}

/** Turns segments into sound. One is made per reply, because it may own an audio context. */
export interface SpeechPlayer {
  render(segment: SpeechSegment, signal: AbortSignal): Promise<Playable>;
  release(): void;
}

export interface SpeechQueue {
  /** Another sentence to say, once the ones before it are done. Ignored after close or abort. */
  push(segment: SpeechSegment): void;
  /** No more are coming. */
  close(): void;
  /** How many segments have been handed over. */
  pushed(): number;
  /** Resolves when everything pushed has been spoken, or she was interrupted. */
  finished(): Promise<void>;
}

export function speakInOrder(player: SpeechPlayer, signal: AbortSignal): SpeechQueue {
  // Rendering starts the moment a segment arrives. The voice server does one at a time, so they
  // queue there in the order they were asked for, and nothing here has to schedule that.
  const rendering: Promise<Playable | null>[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  const nudge = () => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  signal.addEventListener("abort", nudge, { once: true });

  const run = (async () => {
    try {
      for (let i = 0; ; i++) {
        while (i >= rendering.length && !closed && !signal.aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (signal.aborted || i >= rendering.length) return;
        const ready = await rendering[i];
        if (!ready) continue; // this one couldn't be made; the rest still can be
        if (signal.aborted) {
          ready.release();
          return;
        }
        try {
          await ready.play();
        } finally {
          ready.release();
        }
      }
    } finally {
      player.release();
    }
  })();

  return {
    push(segment) {
      if (closed || signal.aborted || !segment.text.trim()) return;
      rendering.push(
        player.render(segment, signal).catch((err) => {
          if (!signal.aborted) console.warn("Couldn't make that piece of her reply", err);
          return null;
        }),
      );
      nudge();
    },
    close() {
      closed = true;
      nudge();
    },
    pushed: () => rendering.length,
    finished: () => run,
  };
}

/**
 * The same player, with something plainer to fall back on per segment. A used-up quota or a stopped
 * voice server shouldn't end the lesson, and one failed sentence shouldn't silence the rest of the
 * reply either.
 */
export function withFallback(primary: SpeechPlayer, backup: SpeechPlayer, warning: string): SpeechPlayer {
  let failed = false;
  return {
    async render(segment, signal) {
      if (!failed) {
        try {
          return await primary.render(segment, signal);
        } catch (err) {
          if (signal.aborted) throw err;
          console.warn(warning, err);
          failed = true; // once it has let us down, stop waiting on it for every later segment
        }
      }
      return backup.render(segment, signal);
    },
    release() {
      primary.release();
      backup.release();
    },
  };
}
