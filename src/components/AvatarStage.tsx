"use client";

import { useEffect, useRef } from "react";
import type { LevelRef } from "./voice";

export type StageState = "idle" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking";

const CAPTIONS: Record<StageState, string> = {
  idle: "Ready when you are",
  listening: "Listening… just speak",
  hearing: "Hearing you…",
  transcribing: "Catching your words…",
  thinking: "Thinking…",
  speaking: "Speaking",
};

/**
 * Phase 1 stand-in for the photoreal avatar. Phase 2 swaps the portrait for a streaming
 * video avatar driven by the same state and audio level.
 */
export function AvatarStage({ name, state, level }: { name: string; state: StageState; level: LevelRef }) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let smoothed = 0;
    const tick = () => {
      smoothed += (level.current - smoothed) * 0.25;
      root.current?.style.setProperty("--level", smoothed.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [level]);

  return (
    <div ref={root} className={`stage stage--${state}`}>
      <div className="stage__portrait" aria-hidden="true">
        <span className="stage__ring stage__ring--outer" />
        <span className="stage__ring" />
        <svg className="stage__figure" viewBox="0 0 120 120">
          <circle cx="60" cy="46" r="21" />
          <path d="M60 71c-22 0-38 13-41 33a60 60 0 0 0 82 0c-3-20-19-33-41-33Z" />
        </svg>
      </div>
      <div className="stage__name">{name}</div>
      <div className="stage__caption" aria-live="polite">
        {CAPTIONS[state]}
      </div>
    </div>
  );
}
