"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CATEGORY_LABELS,
  MODE_LABELS,
  PROVIDER_LABELS,
  ROLEPLAY_SCENARIOS,
  TUTOR_MODES,
  type AppSettings,
  type ChatTurn,
  type InputMethod,
  type ModelChoice,
  type Provider,
  type Session,
  type SessionReview,
  type TutorMode,
  type VocabItem,
  type VoiceProvider,
  type VoiceSettings,
} from "@/lib/types";
import { averageFluency, PACE_GUIDE, type FluencyStats } from "@/lib/fluency";
import { api, errorMessage } from "./api";
import { AvatarStage, type StageState } from "./AvatarStage";
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
  tutorName: string;
}

const BROWSER_VOICE: VoiceSettings = { provider: "browser", geminiModel: "", geminiVoice: "", browserVoiceEn: "", browserVoiceFr: "" };

export function TutorApp() {
  const [health, setHealth] = useState<Health | null>(null);
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [review, setReview] = useState<SessionReview | null>(null);
  const [status, setStatus] = useState<StageState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const level: LevelRef = useRef(0);
  const speaking = useRef<AbortController | null>(null);
  /** True while the student wants to be recorded; lets a quick Space tap cancel a mic that is still starting. */
  const wantsMic = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);
  const { recording, start: startRecording, stop: stopRecording, isRecording } = useRecorder(level);

  const tutorName = health?.tutorName ?? "Charlotte";
  const voice = voiceSettings ?? BROWSER_VOICE;
  const busy = status === "thinking" || status === "transcribing";
  const active = session !== null && session.endedAt === null;

  useEffect(() => {
    api
      .get<Health>("/api/health")
      .then((h) => {
        setHealth(h);
        setVoiceSettings(h.voice);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session?.turns.length, status]);

  const stopSpeaking = useCallback(() => {
    speaking.current?.abort();
    speaking.current = null;
  }, []);

  const say = useCallback(
    async (turn: ChatTurn) => {
      if (!turn.reply) return;
      stopSpeaking();
      const controller = new AbortController();
      speaking.current = controller;
      setStatus("speaking");
      try {
        await speak(turn.reply.speech, voice, level, controller.signal);
      } finally {
        if (speaking.current === controller) {
          speaking.current = null;
          setStatus("idle");
        }
      }
    },
    [voice, level, stopSpeaking],
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
    [say],
  );

  const send = useCallback(
    async (text: string, inputMethod: InputMethod, fluency?: FluencyStats) => {
      const trimmed = text.trim();
      if (!session || !trimmed) return;
      setError(null);
      setStatus("thinking");
      const pending: ChatTurn = { id: `pending-${Date.now()}`, role: "student", text: trimmed, inputMethod, fluency, at: new Date().toISOString() };
      setSession((s) => s && { ...s, turns: [...s.turns, pending] });

      let result: { studentTurn: ChatTurn; tutorTurn: ChatTurn };
      try {
        result = await api.post("/api/tutor", { sessionId: session.id, text: trimmed, inputMethod, fluency });
      } catch (e) {
        setSession((s) => s && { ...s, turns: s.turns.filter((t) => t.id !== pending.id) });
        setDraft(trimmed); // keep what they said so they can resend it
        setError(errorMessage(e));
        setStatus("idle");
        return;
      }
      setSession((s) => s && { ...s, turns: [...s.turns.filter((t) => t.id !== pending.id), result.studentTurn, result.tutorTurn] });
      await say(result.tutorTurn).catch((e) => setError(errorMessage(e)));
    },
    [session, say],
  );

  const startListening = useCallback(async () => {
    if (!active || busy || wantsMic.current) return;
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
  }, [active, busy, stopSpeaking, startRecording, stopRecording]);

  const stopListening = useCallback(async () => {
    wantsMic.current = false;
    if (!isRecording()) return;
    setStatus("transcribing");
    try {
      const clip = await stopRecording();
      if (!clip) return setStatus("idle");
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav", "x-speech-timing": JSON.stringify(clip.timing) },
        body: clip.wav,
      });
      const data = (await res.json().catch(() => ({}))) as { text?: string; fluency?: FluencyStats | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Transcription failed.");
      if (!data.text) {
        setError("I didn't catch that. Try again, a little closer to the mic.");
        return setStatus("idle");
      }
      await send(data.text, "voice", data.fluency ?? undefined);
    } catch (e) {
      setError(errorMessage(e));
      setStatus("idle");
    }
  }, [isRecording, stopRecording, send]);

  const toggleMic = () => void (wantsMic.current ? stopListening() : startListening());

  // Hold Space to talk (unless typing in a field).
  useEffect(() => {
    if (!active) return;
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
  }, [active, startListening, stopListening]);

  const endSession = useCallback(async () => {
    if (!session) return;
    stopSpeaking();
    wantsMic.current = false;
    if (isRecording()) await stopRecording();
    setError(null);
    if (!session.turns.some((t) => t.role === "student")) {
      setSession(null);
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
      setStatus("idle");
    }
  }, [session, stopSpeaking, isRecording, stopRecording]);

  const changeVoice = useCallback((provider: VoiceProvider) => {
    setVoiceSettings((v) => v && { ...v, provider });
    api
      .put<{ settings: AppSettings }>("/api/settings", { voice: { provider } })
      .then((r) => setVoiceSettings(r.settings.voice))
      .catch((e) => setError(errorMessage(e)));
  }, []);

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
                  setStatus("idle");
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
        <div className="voice-toggle" role="radiogroup" aria-label="Tutor voice">
          <span className="voice-toggle__label">Voice</span>
          <button className="seg-btn" role="radio" aria-checked={voice.provider === "gemini"} onClick={() => changeVoice("gemini")} disabled={health?.gemini === false}>
            Gemini
          </button>
          <button className="seg-btn" role="radio" aria-checked={voice.provider === "browser"} onClick={() => changeVoice("browser")}>
            Browser
          </button>
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
          <button
            className={`mic${recording ? " mic--on" : ""}`}
            onClick={toggleMic}
            disabled={!active || (busy && !recording) || health?.transcription.ready === false}
            aria-pressed={recording}
          >
            <MicIcon />
            <span>{recording ? "Done" : "Speak"}</span>
          </button>
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
        <p className="hint">
          {active ? (
            <>
              Click <strong>Speak</strong> or hold <kbd>Space</kbd> to talk. <kbd>Enter</kbd> sends a typed message.
            </>
          ) : (
            "Your sessions, mistakes and progress are saved on this computer."
          )}
        </p>
      </section>

      <aside className="panel tutor__feedback">
        <FeedbackPanel session={session} review={review} ollamaOnline={health?.ollama.online ?? true} />
      </aside>
    </div>
  );
}

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
            {ROLEPLAY_SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} · {s.level}
              </option>
            ))}
          </select>
          {scenario && <span className="small">{scenario.brief}</span>}
        </label>
      )}
      {(mode === "conversation" || mode === "lesson") && (
        <label className="field">
          <span>{mode === "lesson" ? "Grammar point (optional)" : "Topic (optional)"}</span>
          <input
            className="input"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={mode === "lesson" ? "e.g. passé composé vs imparfait" : "e.g. my job, travel, cooking"}
          />
        </label>
      )}
      <button className="btn btn--primary" disabled={busy} onClick={() => onStart(mode, mode === "roleplay" ? scenarioId : null, topic.trim() || null)}>
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
