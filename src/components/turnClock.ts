"use client";

import type { TurnTiming } from "@/lib/types";

/**
 * Times one spoken turn, from the moment the student stops to the moment they hear a reply.
 *
 * Everything is measured from the end of their turn, because that is when they start waiting - but
 * the clock may be made before then, since work on the reply can begin during the pause. So marks are
 * kept as plain timestamps and only turned into waits once `endedAt` says where zero is. A stage that
 * finished before the turn was over counts as no wait at all, which is exactly what it was.
 *
 * It only observes. A turn where she never spoke is not recorded: a half-measured turn would drag the
 * averages towards looking better than the app really is, which is the one thing this must not do.
 */

type Stage = "transcribed" | "firstSegment" | "firstSound" | "words";

export interface TurnClock {
  /** Marks where zero is: the instant the listener decided the turn was over. */
  endedAt(endSilenceMs: number): void;
  mark(stage: Stage): void;
  /** The student carried on talking, so this turn's work was thrown away. */
  restarted(): void;
  save(about: { sessionId: string; model: string; audioSec: number; early: boolean }): void;
}

export function startTurnClock(): TurnClock {
  const at: Partial<Record<Stage, number>> = {};
  let zero: number | null = null;
  let endSilenceMs = 0;
  let restarted = false;

  /** Work finished before the turn ended cost the student nothing, so it floors at zero. */
  const since = (mark: number | undefined): number | undefined => (mark === undefined || zero === null ? undefined : Math.max(0, Math.round(mark - zero)));

  return {
    endedAt(silence) {
      zero ??= performance.now();
      endSilenceMs = silence;
    },
    mark(stage) {
      // First one wins: "first sound" means the first, and a later segment mustn't overwrite it.
      at[stage] ??= performance.now();
    },
    restarted() {
      restarted = true;
    },
    save(about) {
      const words = since(at.words);
      if (words === undefined) return; // she never spoke; there is no wait to report
      const transcribed = since(at.transcribed) ?? 0;
      const firstSegment = since(at.firstSegment) ?? words;
      void fetch("/api/timing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: about.sessionId,
          audioSec: Math.round(about.audioSec * 10) / 10,
          endpointMs: Math.round(endSilenceMs),
          transcribeMs: transcribed,
          brainMs: Math.max(0, firstSegment - transcribed),
          voiceMs: Math.max(0, words - firstSegment),
          firstSoundMs: since(at.firstSound) ?? words,
          wordsMs: words,
          early: about.early,
          restarted,
          model: about.model,
        } satisfies Omit<TurnTiming, "at">),
        keepalive: true,
      }).catch(() => undefined); // recording how long a turn took must never lengthen one
    },
  };
}
