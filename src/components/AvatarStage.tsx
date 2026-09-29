"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { AvatarSettings } from "@/lib/types";
import { Avatar3D } from "./Avatar3D";
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
 * The tutor on screen: a 3D head that lip-syncs to her voice, or the simple portrait if that is
 * what the Settings page asks for. The rings around her follow whoever is talking.
 */
export function AvatarStage({
  name,
  state,
  level,
  avatar,
  videoRef,
}: {
  name: string;
  state: StageState;
  level: LevelRef;
  avatar?: AvatarSettings;
  /** The <video> her replies play in, when she is a photo. Owned by the page so it can speak. */
  videoRef?: RefObject<HTMLVideoElement | null>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [modelError, setModelError] = useState<string | null>(null);

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
      <div className={`stage__portrait${avatar?.mode === "3d" || avatar?.mode === "photo" || avatar?.mode === "still" ? " stage__portrait--3d" : ""}`} aria-hidden="true">
        <span className="stage__ring stage__ring--outer" />
        <span className="stage__ring" />
        {avatar?.mode === "photo" || avatar?.mode === "still" ? (
          <div className="stage__photo">
            <img src={`/api/avatar/face?name=${encodeURIComponent(avatar.photo || "charlotte")}`} alt="" />
            <video ref={videoRef} playsInline preload="auto" />
          </div>
        ) : avatar?.mode === "3d" ? (
          <Avatar3D state={state} level={level} modelUrl={avatar.modelUrl || undefined} onModelError={setModelError} />
        ) : (
          <svg className="stage__figure" viewBox="0 0 120 120">
            <circle cx="60" cy="46" r="21" />
            <path d="M60 71c-22 0-38 13-41 33a60 60 0 0 0 82 0c-3-20-19-33-41-33Z" />
          </svg>
        )}
      </div>
      <div className="stage__name">{name}</div>
      <div className="stage__caption" aria-live="polite">
        {CAPTIONS[state]}
      </div>
      {modelError && <p className="small stage__warning">{modelError}</p>}
    </div>
  );
}
