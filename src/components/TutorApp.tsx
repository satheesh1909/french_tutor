"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  CATEGORY_LABELS,
  CUSTOM_SCENARIO_ID,
  GEMINI_VOICES,
  MODE_LABELS,
  PROVIDER_LABELS,
  ROLEPLAY_SCENARIOS,
  SCENARIO_CATEGORY_LABELS,
  TUTOR_MODES,
  type ScenarioCategory,
  type AppSettings,
  type ChatTurn,
  type ConversationSettings,
  type InputMethod,
  type ModelChoice,
  type Provider,
  type Session,
  type SessionReview,
  type SpeechSegment,
  type TutorMode,
  type VocabItem,
  type VoiceProvider,
  type VoiceSettings,
} from "@/lib/types";
import { averageFluency, PACE_GUIDE, type FluencyStats } from "@/lib/fluency";
import { api, errorMessage } from "./api";
import { clipFromSamples, concatAudio, type RecordedClip } from "./audioClip";
import { AvatarStage, type StageState } from "./AvatarStage";
import { VoiceActivityListener, type MicMeter } from "./handsFree";
import { useRecorder } from "./useRecorder";
import { speak, type LevelRef } from "./voice";

interface Health {
  claude: boolean;
  gemini: boolean;
  ollama: { online: boolean; hasEmbedModel: boolean };
  whisper: { online: boolean; model: string | null; device: string | null };
  transcription: { engine: "gemini" | "whisper"; ready: boolean };
  uses: Record<Provider, boolean>;
  tutor: ModelChoice;
  voice: VoiceSettings;
  conversation: ConversationSettings;
  tutorName: string;
}

const BROWSER_VOICE: VoiceSettings = { provider: "browser", geminiModel: "", geminiVoice: "", browserVoiceEn: "", browserVoiceFr: "" };

interface SendOptions {
  fluency?: FluencyStats;
  /** Id for this answer; lets a later, combined answer replace it. */
  clientTurnId?: string;
  /** Earlier answers this one replaces (hands-free: the student kept talking). */
  supersedes?: string[];
  signal?: AbortSignal;
}

/** A spoken answer that has been sent but not yet replied to; kept so it can be merged if the student continues. */
interface PendingAnswer {
  samples: Float32Array;
  sampleRate: number;
  ids: string[];
  controller: AbortController;
  endedAt: number;
}

async function transcribeClip(clip: RecordedClip, signal?: AbortSignal): Promise<{ text: string; fluency?: FluencyStats }> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav", "x-speech-timing": JSON.stringify(clip.timing) },
    body: clip.wav,
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as { text?: string; fluency?: FluencyStats | null; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Transcription failed.");
  return { text: data.text?.trim() ?? "", fluency: data.fluency ?? undefined };
}

const NOT_CAUGHT = "I didn't catch that. Try again, a little closer to the mic.";

const VOICE_SAMPLE: SpeechSegment[] = [
  { lang: "en", text: "Hello! This is how I sound." },
  { lang: "fr", text: "Et voici ma voix en français : on va bien travailler ensemble !" },
];

/** Live microphone meter: shows what the app hears and how close the pause is to sending. */
function MicLevel({ meter, endSilenceMs, paused }: { meter: RefObject<MicMeter>; endSilenceMs: number; paused: boolean }) {
  const bar = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const mark = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let smoothed = 0;
    const scale = (value: number) => Math.min(1, Math.sqrt(value / 0.15)); // loudness reads better on a curve
    const tick = () => {
      const m = meter.current;
      smoothed += (scale(m.level) - smoothed) * 0.3;
      fill.current?.style.setProperty("width", `${(smoothed * 100).toFixed(1)}%`);
      mark.current?.style.setProperty("left", `${(scale(m.threshold) * 100).toFixed(1)}%`);
      const remaining = m.speaking ? Math.max(0, 1 - m.silenceSec / (endSilenceMs / 1000)) : 1;
      bar.current?.classList.toggle("mic-level--speech", m.level > m.threshold);
      bar.current?.style.setProperty("--pause", remaining.toFixed(2));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [meter, endSilenceMs]);

  return (
    <div className={`mic-level${paused ? " mic-level--off" : ""}`} ref={bar} title="Microphone level. The marker is the level needed to count as speech.">
      <span className="mic-level__fill" ref={fill} />
      <span className="mic-level__mark" ref={mark} />
    </div>
  );
}

export function TutorApp() {
  const [health, setHealth] = useState<Health | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings | null>(null);
  const [conversation, setConversation] = useState<ConversationSettings | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [review, setReview] = useState<SessionReview | null>(null);
  const [status, setStatusState] = useState<StageState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [ending, setEnding] = useState(false);
  const [micPaused, setMicPaused] = useState(false);

  const level: LevelRef = useRef(0);
  const speaking = useRef<AbortController | null>(null);
  /** True while the student wants to be recorded; lets a quick Space tap cancel a mic that is still starting. */
  const wantsMic = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);
  const { recording, start: startRecording, stop: stopRecording, isRecording } = useRecorder(level);

  // The hands-free listener calls back outside React, so it reads the latest values through refs.
  const statusRef = useRef<StageState>("idle");
  const sessionRef = useRef<Session | null>(null);
  const listener = useRef<VoiceActivityListener | null>(null);
  const meter = useRef<MicMeter>({ level: 0, threshold: 0, speaking: false, silenceSec: 0 });
  const pending = useRef<PendingAnswer | null>(null);
  const listenerEvents = useRef({ speechStart: () => {}, utterance: (_s: Float32Array, _r: number) => {}, discard: () => {} });

  const tutorName = health?.tutorName ?? "Charlotte";
  const voice = voiceSettings ?? BROWSER_VOICE;
  const busy = status === "thinking" || status === "transcribing";
  const active = session !== null && session.endedAt === null;
  const transcriptionReady = health?.transcription.ready ?? false;
  const handsFree = Boolean(conversation?.handsFree && active && !ending && transcriptionReady);

  const setStatus = useCallback((next: StageState) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  /** Where to return when nothing is happening: listening in hands-free mode, idle otherwise. */
  const settle = useCallback(() => setStatus(listener.current ? "listening" : "idle"), [setStatus]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    api
      .get<Health>("/api/health")
      .then((h) => {
        setHealth(h);
        setVoiceSettings(h.voice);
        setConversation(h.conversation);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session?.turns.length, status]);

  const stopSpeaking = useCallback(() => {
    speaking.current?.abort();
    speaking.current = null;
    if (listener.current) listener.current.tutorSpeaking = false;
  }, []);

  const say = useCallback(
    async (turn: ChatTurn) => {
      if (!turn.reply) return;
      stopSpeaking();
      const controller = new AbortController();
      speaking.current = controller;
      if (listener.current) listener.current.tutorSpeaking = true;
      setStatus("speaking");
      try {
        await speak(turn.reply.speech, voice, level, controller.signal);
      } finally {
        if (speaking.current === controller) {
          speaking.current = null;
          if (listener.current) listener.current.tutorSpeaking = false;
          settle();
        }
      }
    },
    [voice, level, stopSpeaking, setStatus, settle],
  );

  const startSession = useCallback(
    async (mode: TutorMode, scenarioId: string | null, topic: string | null) => {
      setError(null);
      setReview(null);
      setStatus("thinking");
      let created: Session;
      try {
        ({ session: created } = await api.post<{ session: Session }>("/api/session", { mode, scenarioId, topic }));
      } catch (e) {
        setError(errorMessage(e));
        setStatus("idle");
        return;
      }
      setSession(created);
      const opening = created.turns.findLast((t) => t.role === "tutor");
      if (!opening) return setStatus("idle");
      await say(opening).catch((e) => setError(errorMessage(e)));
    },
    [say, setStatus],
  );

  /** Sends an answer and plays the reply. Returns quietly if the answer was cancelled because the student kept talking. */
  const send = useCallback(
    async (text: string, inputMethod: InputMethod, options: SendOptions = {}) => {
      const current = sessionRef.current;
      const trimmed = text.trim();
      if (!current || !trimmed) return;
      const id = options.clientTurnId ?? crypto.randomUUID();
      const replaced = new Set(options.supersedes ?? []);
      const isReplaced = (t: ChatTurn) => replaced.has(t.clientTurnId ?? t.id);
      setError(null);
      setStatus("thinking");
      const shown: ChatTurn = { id, clientTurnId: id, role: "student", text: trimmed, inputMethod, fluency: options.fluency, at: new Date().toISOString() };
      setSession((s) => s && { ...s, turns: [...s.turns.filter((t) => !isReplaced(t)), shown] });

      let result: { studentTurn: ChatTurn; tutorTurn: ChatTurn };
      try {
        result = await api.post(
          "/api/tutor",
          { sessionId: current.id, text: trimmed, inputMethod, fluency: options.fluency, clientTurnId: id, supersedes: options.supersedes },
          options.signal,
        );
      } catch (e) {
        if (options.signal?.aborted) return; // the combined answer takes over
        if (pending.current?.ids.includes(id)) pending.current = null;
        setSession((s) => s && { ...s, turns: s.turns.filter((t) => t.id !== id) });
        setDraft(trimmed); // keep what they said so they can resend it
        setError(errorMessage(e));
        settle();
        return;
      }
      if (options.signal?.aborted) return;
      if (pending.current?.ids.includes(id)) pending.current = null; // answered: no longer mergeable
      setSession((s) => s && { ...s, turns: [...s.turns.filter((t) => t.id !== id && !isReplaced(t)), result.studentTurn, result.tutorTurn] });
      await say(result.tutorTurn).catch((e) => setError(errorMessage(e)));
    },
    [say, setStatus, settle],
  );

  // ---------------------------------------------------------------------------
  // Hands-free conversation
  // ---------------------------------------------------------------------------

  /**
   * A finished spoken answer. If the previous answer is still being processed (the student paused,
   * then carried on), that processing was cancelled when they started again, and both parts are
   * sent together as one answer.
   */
  const handleUtterance = useCallback(
    async (samples: Float32Array, sampleRate: number) => {
      const previous = pending.current;
      let audio = samples;
      if (previous) {
        previous.controller.abort();
        if (previous.sampleRate === sampleRate) {
          const startedAt = Date.now() - (samples.length / sampleRate) * 1000;
          const gapSec = Math.min(1, Math.max(0.3, (startedAt - previous.endedAt) / 1000));
          audio = concatAudio([previous.samples, new Float32Array(Math.round(gapSec * sampleRate)), samples]);
        }
      }
      const replaces = previous?.ids ?? [];
      if (audio.length === 0) {
        pending.current = null;
        return settle();
      }

      const id = crypto.randomUUID();
      const controller = new AbortController();
      pending.current = { samples: audio, sampleRate, ids: [...replaces, id], controller, endedAt: Date.now() };
      if (replaces.length) setSession((s) => s && { ...s, turns: s.turns.filter((t) => !replaces.includes(t.clientTurnId ?? t.id)) });
      setStatus("transcribing");
      try {
        const clip = await clipFromSamples(audio, sampleRate);
        const heard = clip ? await transcribeClip(clip, controller.signal) : { text: "" };
        if (controller.signal.aborted) return;
        if (!heard.text) {
          pending.current = null;
          setError(NOT_CAUGHT);
          return settle();
        }
        await send(heard.text, "voice", { fluency: heard.fluency, clientTurnId: id, supersedes: replaces, signal: controller.signal });
      } catch (e) {
        if (controller.signal.aborted) return;
        pending.current = null;
        setError(errorMessage(e));
        settle();
      }
    },
    [send, setStatus, settle],
  );

  useEffect(() => {
    listenerEvents.current = {
      // The student started talking: stop her voice, pause any processing, and listen.
      speechStart: () => {
        if (speaking.current) stopSpeaking();
        pending.current?.controller.abort();
        setError(null);
        setStatus("hearing");
      },
      utterance: (samples, rate) => void handleUtterance(samples, rate),
      // Just a noise. If that noise interrupted an answer in progress, send that answer again.
      discard: () => {
        const previous = pending.current;
        if (previous?.controller.signal.aborted) void handleUtterance(new Float32Array(0), previous.sampleRate);
        else settle();
      },
    };
  }, [handleUtterance, stopSpeaking, setStatus, settle]);

  useEffect(() => {
    if (!handsFree || !conversation) return;
    const created = new VoiceActivityListener({
      endSilenceMs: conversation.endSilenceMs,
      sensitivity: conversation.sensitivity,
      level,
      meter: meter.current,
      onSpeechStart: () => listenerEvents.current.speechStart(),
      onUtterance: (samples, rate) => listenerEvents.current.utterance(samples, rate),
      onDiscard: () => listenerEvents.current.discard(),
    });
    let cancelled = false;
    created
      .start()
      .then(() => {
        if (cancelled) return created.stop();
        created.tutorSpeaking = speaking.current !== null;
        listener.current = created;
        if (statusRef.current === "idle") setStatus("listening");
      })
      .catch((e) => {
        created.stop();
        if (!cancelled) setError(`Microphone unavailable: ${errorMessage(e)}`);
      });
    return () => {
      cancelled = true;
      created.stop();
      if (listener.current === created) listener.current = null;
      if (statusRef.current === "listening" || statusRef.current === "hearing") setStatus("idle");
    };
    // Restart only when hands-free turns on or off; other changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handsFree]);

  useEffect(() => {
    const l = listener.current;
    if (!l || !conversation) return;
    l.update({ endSilenceMs: conversation.endSilenceMs, sensitivity: conversation.sensitivity });
    l.allowInterrupt = conversation.bargeIn;
    l.paused = micPaused;
  }, [conversation, micPaused, status]);

  const changeConversation = useCallback((changes: Partial<ConversationSettings>) => {
    setConversation((c) => c && { ...c, ...changes });
    api
      .put<{ settings: AppSettings }>("/api/settings", { conversation: changes })
      .then((r) => setConversation(r.settings.conversation))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  // ---------------------------------------------------------------------------
  // Push-to-talk (hands-free off)
  // ---------------------------------------------------------------------------

  const startListening = useCallback(async () => {
    if (!active || busy || wantsMic.current || handsFree) return;
    wantsMic.current = true;
    stopSpeaking();
    setError(null);
    try {
      await startRecording();
    } catch (e) {
      wantsMic.current = false;
      setError(`Microphone unavailable: ${errorMessage(e)}`);
      setStatus("idle");
      return;
    }
    if (!wantsMic.current) {
      await stopRecording(); // released before the mic finished starting
      setStatus("idle");
      return;
    }
    setStatus("listening");
  }, [active, busy, handsFree, stopSpeaking, startRecording, stopRecording, setStatus]);

  const stopListening = useCallback(async () => {
    wantsMic.current = false;
    if (!isRecording()) return;
    setStatus("transcribing");
    try {
      const clip = await stopRecording();
      if (!clip) return setStatus("idle");
      const heard = await transcribeClip(clip);
      if (!heard.text) {
        setError(NOT_CAUGHT);
        return setStatus("idle");
      }
      await send(heard.text, "voice", { fluency: heard.fluency });
    } catch (e) {
      setError(errorMessage(e));
      setStatus("idle");
    }
  }, [isRecording, stopRecording, send, setStatus]);

  const toggleMic = () => void (wantsMic.current ? stopListening() : startListening());

  // Hold Space to talk (unless typing in a field). Not needed in hands-free mode.
  useEffect(() => {
    if (!active || handsFree) return;
    const typing = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || typing(e.target)) return;
      e.preventDefault();
      void startListening();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault();
      void stopListening();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [active, handsFree, startListening, stopListening]);

  const endSession = useCallback(async () => {
    if (!session) return;
    setEnding(true); // switches hands-free listening off
    stopSpeaking();
    pending.current?.controller.abort();
    pending.current = null;
    wantsMic.current = false;
    if (isRecording()) await stopRecording();
    setError(null);
    if (!session.turns.some((t) => t.role === "student")) {
      setSession(null);
      setEnding(false);
      return setStatus("idle");
    }
    setStatus("thinking");
    try {
      const res = await api.post<{ review: SessionReview | null }>("/api/session/end", { sessionId: session.id });
      setReview(res.review);
      setSession((s) => s && { ...s, endedAt: new Date().toISOString(), review: res.review });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnding(false);
      setStatus("idle");
    }
  }, [session, stopSpeaking, isRecording, stopRecording, setStatus]);

  const changeVoice = useCallback((patch: Partial<VoiceSettings>) => {
    setVoiceSettings((v) => v && { ...v, ...patch });
    api
      .put<{ settings: AppSettings }>("/api/settings", { voice: patch })
      .then((r) => setVoiceSettings(r.settings.voice))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  /** Plays a short sample so a voice can be tried before (and after) choosing it. */
  const previewVoice = useCallback(
    async (geminiVoice?: string) => {
      stopSpeaking();
      const controller = new AbortController();
      speaking.current = controller;
      if (listener.current) listener.current.tutorSpeaking = true;
      setStatus("speaking");
      try {
        await speak(VOICE_SAMPLE, geminiVoice ? { ...voice, provider: "gemini", geminiVoice } : voice, level, controller.signal);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        if (speaking.current === controller) {
          speaking.current = null;
          if (listener.current) listener.current.tutorSpeaking = false;
          settle();
        }
      }
    },
    [voice, level, stopSpeaking, setStatus, settle],
  );

  const submitDraft = () => {
    if (!draft.trim() || busy) return;
    const text = draft;
    setDraft("");
    void send(text, "text");
  };

  const scenario = session?.scenarioId ? ROLEPLAY_SCENARIOS.find((s) => s.id === session.scenarioId) : undefined;

  return (
    <div className="tutor">
      <section className="panel tutor__stage">
        <AvatarStage name={tutorName} state={status} level={level} />
        {session ? (
          <div className="stage-controls">
            <p className="session-tag">
              {MODE_LABELS[session.mode].title}
              {scenario ? ` · ${scenario.title}` : session.topic ? ` · ${session.topic}` : ""}
            </p>
            {status === "speaking" && (
              <button
                className="btn btn--ghost"
                onClick={() => {
                  stopSpeaking();
                  settle();
                }}
              >
                Stop speaking
              </button>
            )}
            {active ? (
              <button className="btn" onClick={() => void endSession()} disabled={busy}>
                End &amp; review
              </button>
            ) : (
              <button
                className="btn btn--primary"
                onClick={() => {
                  setSession(null);
                  setReview(null);
                }}
              >
                New session
              </button>
            )}
          </div>
        ) : (
          <SessionPicker busy={busy} onStart={(m, s, t) => void startSession(m, s, t)} />
        )}
        <div className="voice-picker">
          <div className="voice-toggle" role="radiogroup" aria-label="Tutor voice">
            <span className="voice-toggle__label">Voice</span>
            <button
              className="seg-btn"
              role="radio"
              aria-checked={voice.provider === "gemini"}
              onClick={() => changeVoice({ provider: "gemini" })}
              disabled={health?.gemini === false}
            >
              Gemini
            </button>
            <button className="seg-btn" role="radio" aria-checked={voice.provider === "browser"} onClick={() => changeVoice({ provider: "browser" })}>
              Browser
            </button>
          </div>
          {voice.provider === "gemini" && (
            <div className="voice-picker__row">
              <select
                className="input"
                aria-label="Gemini voice"
                value={voice.geminiVoice}
                onChange={(e) => {
                  const geminiVoice = e.target.value;
                  changeVoice({ geminiVoice });
                  void previewVoice(geminiVoice);
                }}
              >
                {GEMINI_VOICES.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} · {v.style}
                  </option>
                ))}
              </select>
              <button className="btn btn--ghost" onClick={() => (status === "speaking" ? (stopSpeaking(), settle()) : void previewVoice())}>
                {status === "speaking" ? "Stop" : "Hear"}
              </button>
            </div>
          )}
        </div>
        {health && (
          <p className="brain-tag">
            Tutor brain: {PROVIDER_LABELS[health.tutor.provider]} · {health.tutor.model} · <Link href="/settings">Change</Link>
          </p>
        )}
      </section>

      <section className="panel tutor__chat">
        <SetupNotice health={health} />
        <div className="chat__log">
          {session ? (
            <Transcript turns={session.turns} onReplay={(t) => void say(t).catch((e) => setError(errorMessage(e)))} />
          ) : (
            <div className="chat__empty">
              <h2>Bonjour !</h2>
              <p className="muted">
                Choose an activity and {tutorName} will start the conversation. Speak or type in French, and your corrections appear as you go.
              </p>
            </div>
          )}
          {session && status === "thinking" && (
            <div className="bubble bubble--tutor typing" aria-label={`${tutorName} is thinking`}>
              <span />
              <span />
              <span />
            </div>
          )}
          <div ref={logEnd} />
        </div>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        <div className="composer">
          {handsFree ? (
            <button
              className={`mic mic--live${micPaused ? " mic--paused" : status === "hearing" ? " mic--on" : ""}`}
              onClick={() => setMicPaused((p) => !p)}
              aria-pressed={!micPaused}
              title={micPaused ? "Resume listening" : "Pause listening"}
            >
              <MicIcon />
              <span>{micPaused ? "Paused" : status === "hearing" ? "Hearing you" : "Listening"}</span>
            </button>
          ) : null}
          {handsFree && <MicLevel meter={meter} endSilenceMs={conversation?.endSilenceMs ?? 2000} paused={micPaused} />}
          {handsFree && status === "hearing" && (
            <button className="btn btn--ghost" onClick={() => listener.current?.finishNow()} title="Don't wait for the pause">
              Send now
            </button>
          )}
          {!handsFree && (
            <button
              className={`mic${recording ? " mic--on" : ""}`}
              onClick={toggleMic}
              disabled={!active || (busy && !recording) || !transcriptionReady}
              aria-pressed={recording}
            >
              <MicIcon />
              <span>{recording ? "Done" : "Speak"}</span>
            </button>
          )}
          <textarea
            className="input"
            rows={1}
            lang="fr"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitDraft();
              }
            }}
            placeholder={active ? "Écris en français…" : "Start a session first"}
            disabled={!active}
            aria-label="Message"
          />
          <button className="btn btn--primary" onClick={submitDraft} disabled={!active || busy || !draft.trim()}>
            Send
          </button>
        </div>
        <div className="hint-row">
          <p className="hint">
            {!active ? (
              "Your sessions, mistakes and progress are saved on this computer."
            ) : handsFree ? (
              <>
                Just speak. Your answer is sent after a {((conversation?.endSilenceMs ?? 2000) / 1000).toFixed(1)} s pause
                {conversation?.bargeIn ? `, and you can talk over ${tutorName} to interrupt` : ""}. Headphones work best.
              </>
            ) : (
              <>
                Click <strong>Speak</strong> or hold <kbd>Space</kbd> to talk. <kbd>Enter</kbd> sends a typed message.
              </>
            )}
          </p>
          {conversation && (
            <label className="switch small">
              <input type="checkbox" checked={conversation.handsFree} onChange={(e) => changeConversation({ handsFree: e.target.checked })} />
              <span>Hands-free</span>
            </label>
          )}
        </div>
      </section>

      <aside className="panel tutor__feedback">
        <FeedbackPanel session={session} review={review} ollamaOnline={health?.ollama.online ?? true} />
      </aside>
    </div>
  );
}

/** The scenario list, split into the groups shown in the picker. */
const SCENARIO_GROUPS: [ScenarioCategory, typeof ROLEPLAY_SCENARIOS][] = (["everyday", "work"] as ScenarioCategory[]).map((category) => [
  category,
  ROLEPLAY_SCENARIOS.filter((s) => s.category === category),
]);

const TOPIC_LABELS = {
  conversation: "Topic (optional)",
  lesson: "Grammar point (optional)",
  roleplay: "The situation",
  roleplay_detail: "Anything to add (optional)",
} as const;

const TOPIC_HINTS = {
  conversation: "e.g. my job, travel, cooking",
  lesson: "e.g. passé composé vs imparfait",
  roleplay: "e.g. I chair a project call with a supplier who is late",
  roleplay_detail: "e.g. I'm a data engineer, the client is in Lyon",
} as const;

function SessionPicker({ busy, onStart }: { busy: boolean; onStart: (mode: TutorMode, scenarioId: string | null, topic: string | null) => void }) {
  const [mode, setMode] = useState<TutorMode>("conversation");
  const [scenarioId, setScenarioId] = useState(ROLEPLAY_SCENARIOS[0].id);
  const [topic, setTopic] = useState("");
  const scenario = ROLEPLAY_SCENARIOS.find((s) => s.id === scenarioId);

  return (
    <div className="picker">
      <h2>Start a session</h2>
      <div className="modes" role="radiogroup" aria-label="Activity">
        {TUTOR_MODES.map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} className={`mode${mode === m ? " mode--active" : ""}`} onClick={() => setMode(m)}>
            <strong>{MODE_LABELS[m].title}</strong>
            <span>{MODE_LABELS[m].description}</span>
          </button>
        ))}
      </div>
      {mode === "roleplay" && (
        <label className="field">
          <span>Scenario</span>
          <select className="input" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            {SCENARIO_GROUPS.map(([category, scenarios]) => (
              <optgroup key={category} label={SCENARIO_CATEGORY_LABELS[category]}>
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} · {s.level}
                  </option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Your own">
              <option value={CUSTOM_SCENARIO_ID}>Describe a situation…</option>
            </optgroup>
          </select>
          {scenario && <span className="small">{scenario.brief}</span>}
        </label>
      )}
      {(mode === "conversation" || mode === "lesson" || mode === "roleplay") && (
        <label className="field">
          <span>{TOPIC_LABELS[mode === "roleplay" && scenario ? "roleplay_detail" : mode]}</span>
          <input
            className="input"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={TOPIC_HINTS[mode === "roleplay" && scenario ? "roleplay_detail" : mode]}
          />
        </label>
      )}
      <button
        className="btn btn--primary"
        disabled={busy || (mode === "roleplay" && scenarioId === CUSTOM_SCENARIO_ID && !topic.trim())}
        onClick={() => onStart(mode, mode === "roleplay" ? scenarioId : null, topic.trim() || null)}
      >
        {busy ? "Starting…" : "Commencer"}
      </button>
    </div>
  );
}

function SetupNotice({ health }: { health: Health | null }) {
  if (!health) return null;
  const issues: string[] = [];
  if (health.uses.claude && !health.claude) {
    issues.push("A job is set to Claude, but Claude isn't connected. Add ANTHROPIC_API_KEY to .env.local and restart, or pick another model in Settings.");
  }
  if (!health.transcription.ready) {
    issues.push(
      health.transcription.engine === "whisper"
        ? 'Transcription is set to local Whisper, but its server isn\'t running, so the microphone is off. Run "npm run whisper", or switch to Gemini in Settings.'
        : "Gemini isn't connected, so the microphone is off. Add GEMINI_API_KEY to .env.local, or use local Whisper (Settings). You can type meanwhile.",
    );
  }
  if (health.voice.provider === "gemini" && !health.gemini) issues.push("The Gemini voice needs a Gemini key; the browser voice is used instead.");
  if (health.uses.ollama && !health.ollama.online) issues.push("A job is set to a local model, but Ollama isn't running. Start Ollama or pick another model in Settings.");
  if (issues.length === 0) return null;
  return (
    <div className="notice">
      {issues.map((i) => (
        <p key={i}>{i}</p>
      ))}
    </div>
  );
}

function Transcript({ turns, onReplay }: { turns: ChatTurn[]; onReplay: (turn: ChatTurn) => void }) {
  const visible = turns.filter((t) => t.role !== "note");
  return (
    <>
      {visible.map((turn, i) => {
        if (turn.role === "student") {
          const next = visible[i + 1];
          const fixes = next?.role === "tutor" ? (next.reply?.corrections ?? []) : [];
          return (
            <div key={turn.id} className="turn turn--student">
              <div className="bubble bubble--student" lang="fr">
                {turn.text}
              </div>
              <div className="turn__meta">
                {turn.inputMethod === "voice" ? "Spoken" : "Typed"}
                {turn.fluency?.reliable && ` · ${turn.fluency.wpm} wpm · ${turn.fluency.pauses} pause${turn.fluency.pauses === 1 ? "" : "s"}`}
                {fixes.length > 0 && ` · ${fixes.length} correction${fixes.length === 1 ? "" : "s"}`}
              </div>
              {fixes.length > 0 && (
                <ul className="inline-fixes">
                  {fixes.map((c, k) => (
                    <li key={k} lang="fr">
                      <s>{c.original}</s> → <strong>{c.corrected}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        }
        return (
          <div key={turn.id} className="turn turn--tutor">
            <div className="bubble bubble--tutor">
              {turn.reply
                ? turn.reply.speech.map((s, k) => (
                    <span key={k} lang={s.lang} className={`seg seg--${s.lang}`}>
                      {s.text}{" "}
                    </span>
                  ))
                : turn.text}
            </div>
            <button className="link" onClick={() => onReplay(turn)}>
              Replay
            </button>
          </div>
        );
      })}
    </>
  );
}

function FeedbackPanel({ session, review, ollamaOnline }: { session: Session | null; review: SessionReview | null; ollamaOnline: boolean }) {
  const turns = session?.turns ?? [];
  const corrections = turns.flatMap((t) => t.reply?.corrections ?? []).reverse();
  const vocab = [...new Map(turns.flatMap((t) => t.reply?.vocabulary ?? []).map((v): [string, VocabItem] => [v.french.toLowerCase(), v])).values()].reverse();
  const timed = turns.flatMap((t) => (t.fluency ? [t.fluency] : []));
  const speed = averageFluency(timed);
  const lastTimed = timed.filter((f) => f.reliable).at(-1);

  return (
    <div className="feedback">
      {review && <ReviewSummary review={review} />}
      <h2 className="section-title">Speaking speed</h2>
      {speed && lastTimed ? (
        <div className="speed">
          <div className="speed__stats">
            <div>
              <strong>{speed.wpm}</strong>
              <span>wpm this session</span>
            </div>
            <div>
              <strong>{lastTimed.wpm}</strong>
              <span>last answer</span>
            </div>
            <div>
              <strong>{speed.pausesPerMinute}</strong>
              <span>pauses / min</span>
            </div>
          </div>
          <p className="small muted">
            {speed.articulationWpm} wpm while talking (pauses left out) · measured {lastTimed.source === "whisper" ? "with Whisper word timings" : "from the recording"}
          </p>
          <p className="small muted">Rough guide: {PACE_GUIDE.map((p) => `${p.level} ${p.range}`).join(" · ")} wpm</p>
        </div>
      ) : (
        <p className="muted small">Speak an answer of a few words and your speaking speed appears here.</p>
      )}
      <h2 className="section-title">
        Corrections <span className="count">{corrections.length}</span>
      </h2>
      {corrections.length === 0 ? (
        <p className="muted small">When you make a mistake, the correction and the rule behind it appear here.</p>
      ) : (
        <ul className="corrections">
          {corrections.map((c, i) => (
            <li key={`${c.original}-${i}`} className={`correction correction--${c.severity}`}>
              <div className="correction__pair" lang="fr">
                <s>{c.original}</s>
                <span aria-hidden="true">→</span>
                <strong>{c.corrected}</strong>
              </div>
              <div className="correction__meta">
                <span className="chip">{CATEGORY_LABELS[c.category]}</span>
              </div>
              <p className="small">{c.explanation}</p>
            </li>
          ))}
        </ul>
      )}
      <h2 className="section-title">
        New vocabulary <span className="count">{vocab.length}</span>
      </h2>
      {vocab.length === 0 ? (
        <p className="muted small">Useful new words are collected here and added to your review deck.</p>
      ) : (
        <ul className="vocab">
          {vocab.map((v) => (
            <li key={v.french}>
              <strong lang="fr">{v.french}</strong>
              <span className="small">{v.english}</span>
              <em lang="fr">{v.example}</em>
            </li>
          ))}
        </ul>
      )}
      {!ollamaOnline && <p className="muted small">Ollama is offline, so similar past mistakes aren&apos;t being recalled. Everything else works.</p>}
    </div>
  );
}

function ReviewSummary({ review }: { review: SessionReview }) {
  return (
    <div className="review">
      <h2 className="section-title">Session review</h2>
      <p>{review.summary}</p>
      <div className="levels">
        {(["overall", "speaking", "grammar", "vocabulary"] as const).map((k) => (
          <div key={k} className="level">
            <span>{k}</span>
            <strong>{review.levels[k]}</strong>
          </div>
        ))}
      </div>
      <p className="small muted">{review.levelNotes}</p>
      {review.fluencyNote && (
        <>
          <h3 className="subhead">Speaking speed</h3>
          <p className="small">{review.fluencyNote}</p>
        </>
      )}
      <h3 className="subhead">What went well</h3>
      <ul>
        {review.strengths.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <h3 className="subhead">Work on next</h3>
      <ul>
        {review.focusAreas.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <h3 className="subhead">Next session</h3>
      <p>{review.nextSessionPlan}</p>
      <p className="encouragement">{review.encouragement}</p>
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
