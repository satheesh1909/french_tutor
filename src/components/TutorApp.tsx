"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  CATEGORY_LABELS,
  CUSTOM_SCENARIO_ID,
  GEMINI_VOICES,
  MODE_LABELS,
  PROVIDER_LABELS,
  GRAMMAR_TOPICS,
  CUSTOM_TOPIC_ID,
  MATERIAL_MAX_CHARS,
  ROLEPLAY_SCENARIOS,
  SCENARIO_CATEGORY_LABELS,
  SPEECH_SPEED_RANGE,
  TUTOR_MODES,
  VOICE_REGISTERS,
  voiceRegister,
  type ScenarioCategory,
  type CefrLevel,
  type Material,
  type AppSettings,
  type AvatarSettings,
  type ChatTurn,
  type ConversationSettings,
  type HeardLanguage,
  type InputMethod,
  type ModelChoice,
  type Provider,
  type Session,
  type SessionReview,
  type SpeechSegment,
  type TutorMode,
  type VocabItem,
  type VoiceProvider,
  type VoiceRegister,
  type VoiceSettings,
  type LocalVoiceStatus,
} from "@/lib/types";
import { averageFluency, PACE_GUIDE, type FluencyStats } from "@/lib/fluency";
import { endpointFor } from "@/lib/endpoint";
import { api, errorMessage } from "./api";
import { clipFromSamples, concatAudio, type RecordedClip } from "./audioClip";
import { AvatarStage, type StageState } from "./AvatarStage";
import { photoPlayer } from "./photoAvatar";
import { VoiceActivityListener, type MicMeter, type UtteranceInfo } from "./handsFree";
import { thinkingSound, type ThinkingSound } from "./thinkingSound";
import { startTurnClock, type TurnClock } from "./turnClock";
import { useRecorder } from "./useRecorder";
import { voicePlayer, type LevelRef } from "./voice";
import { speakInOrder, withFallback, type SpeechPlayer } from "./speechQueue";

/** One line of the tutor's streamed answer. See src/app/api/tutor/route.ts. */
type TutorLine =
  | { type: "segment"; segment: SpeechSegment }
  | { type: "turn"; studentTurn: ChatTurn; tutorTurn: ChatTurn }
  | { type: "error"; error: string };

interface Health {
  claude: boolean;
  gemini: boolean;
  ollama: { online: boolean; hasEmbedModel: boolean };
  whisper: { online: boolean; model: string | null; device: string | null };
  transcription: { engine: "gemini" | "whisper"; ready: boolean };
  uses: Record<Provider, boolean>;
  tutor: ModelChoice;
  voice: VoiceSettings;
  /** Only present when the chosen voice is a local one: whether its server is up. */
  voiceServer: LocalVoiceStatus | null;
  avatar: AvatarSettings;
  /** Only present when the avatar is a photo: whether the local lip-sync server is up. */
  avatarServer: { online: boolean; starting: boolean; device: string | null; faces: string[] } | null;
  conversation: ConversationSettings;
  tutorName: string;
}

const VOICE_PICKS: { provider: VoiceProvider; label: string; hint: string }[] = [
  { provider: "piper", label: "Local", hint: "Piper on this computer: instant, unlimited, a separate voice per language" },
  { provider: "xtts", label: "One voice", hint: "XTTS on this computer: the same voice in both languages, but slow to prepare a reply" },
  { provider: "gemini", label: "Gemini", hint: "Google's voices; the free tier runs out after about a hundred clips a day" },
  { provider: "browser", label: "Browser", hint: "The voices installed in Windows" },
];

// The browser speaks at its own rate, so the Piper paces here are placeholders it never reads.
const BROWSER_VOICE: VoiceSettings = {
  provider: "browser",
  geminiModel: "",
  geminiVoice: "",
  xttsSpeaker: "",
  piperVoiceFr: "",
  piperVoiceEn: "",
  piperSpeedFr: SPEECH_SPEED_RANGE.default,
  piperSpeedEn: SPEECH_SPEED_RANGE.default,
  browserVoiceEn: "",
  browserVoiceFr: "",
};

interface SendOptions {
  fluency?: FluencyStats;
  /** Which language the recording was taken to be in, so a doubtful one is visible in the transcript. */
  heard?: HeardLanguage;
  /** Id for this answer; lets a later, combined answer replace it. */
  clientTurnId?: string;
  /** Earlier answers this one replaces (hands-free: the student kept talking). */
  supersedes?: string[];
  signal?: AbortSignal;
  /** Stopwatch for this turn, if it is being timed. */
  clock?: TurnClock;
}

/**
 * Transcription started while the student was still inside their pause.
 *
 * `samples` is how much of the turn it covers. When the turn ends, that is compared with the finished
 * recording: if the student simply stopped, the two are the same bar a little trailing silence and
 * this result is the turn's transcript, already most of the way done. If they carried on, it covers
 * only part of what they said and is thrown away.
 */
interface EarlyTranscript {
  samples: number;
  sampleRate: number;
  result: Promise<{ text: string; fluency?: FluencyStats; heard?: HeardLanguage }>;
  controller: AbortController;
}

/** A spoken answer that has been sent but not yet replied to; kept so it can be merged if the student continues. */
interface PendingAnswer {
  samples: Float32Array;
  sampleRate: number;
  ids: string[];
  controller: AbortController;
  endedAt: number;
}

async function transcribeClip(clip: RecordedClip, signal?: AbortSignal): Promise<{ text: string; fluency?: FluencyStats; heard?: HeardLanguage }> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav", "x-speech-timing": JSON.stringify(clip.timing) },
    body: clip.wav,
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as {
    text?: string;
    fluency?: FluencyStats | null;
    heard?: HeardLanguage | null;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? "Transcription failed.");
  return { text: data.text?.trim() ?? "", fluency: data.fluency ?? undefined, heard: data.heard ?? undefined };
}

/** The whole turn at once: what happens when transcribing alongside the speech is switched off. */
async function transcribeWhole(
  samples: Float32Array,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<{ text: string; fluency?: FluencyStats; heard?: HeardLanguage }> {
  const clip = await clipFromSamples(samples, sampleRate);
  return clip ? transcribeClip(clip, signal) : { text: "" };
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
  /** Transcription of the current turn, started during a pause in it. */
  const early = useRef<EarlyTranscript | null>(null);
  const thinking = useRef<ThinkingSound | null>(null);
  const conversationRef = useRef<ConversationSettings | null>(null);
  /** The turn being timed right now, so the thinking noise can mark the turn it belongs to. */
  const turnClock = useRef<TurnClock | null>(null);
  const listenerEvents = useRef({
    speechStart: () => {},
    speechConfirmed: () => {},
    utterance: (_s: Float32Array, _r: number, _i: UtteranceInfo) => {},
    discard: () => {},
    early: (_s: Float32Array, _r: number) => {},
  });
  const avatarVideo = useRef<HTMLVideoElement | null>(null);

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
    conversationRef.current = conversation;
  }, [conversation]);

  /**
   * Her thinking noise, rebuilt whenever the voice changes so it is always her current voice. Making
   * the phrases also warms the voice server, which is why it happens when a session opens rather than
   * at the first pause - the first turn of a session used to be the slowest of the lot.
   */
  useEffect(() => {
    if (!voiceSettings || !active) return;
    const sound = thinkingSound(
      voiceSettings,
      level,
      () => turnClock.current?.mark("firstSound"),
      // Her voice, as far as the microphone is concerned - unless her real voice is already going,
      // in which case that is what owns the flag and this must not clear it.
      (sounding) => {
        if (listener.current) listener.current.tutorSpeaking = sounding || speaking.current !== null;
      },
    );
    thinking.current = sound;
    if (conversationRef.current?.thinkingSound) sound.prepare();
    return () => {
      sound.release();
      if (thinking.current === sound) thinking.current = null;
    };
  }, [voiceSettings, active, level]);

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

  /**
   * However she is drawn: a lip-synced video when she is a photo, otherwise plain audio. If the
   * lip-sync server is missing or refuses, she still speaks - the picture just doesn't move.
   */
  const buildPlayer = useCallback(
    (geminiVoice?: string): SpeechPlayer => {
      const chosen = geminiVoice ? { ...voice, provider: "gemini" as const, geminiVoice } : voice;
      const plain = voicePlayer(chosen, level);
      const asPhoto = health?.avatar.mode === "photo" && health.avatarServer?.online && avatarVideo.current;
      if (!asPhoto) return plain;
      return withFallback(photoPlayer(chosen, level, avatarVideo.current!), plain, "The lip-sync server didn't answer; speaking without it.");
    },
    [voice, level, health],
  );

  const stopSpeaking = useCallback(() => {
    speaking.current?.abort();
    speaking.current = null;
    if (listener.current) listener.current.tutorSpeaking = false;
  }, []);

  /**
   * Opens a queue she speaks from, and holds "speaking" until it drains. Sentences can be pushed as
   * they arrive, which is the whole point: a reply that is still being written can already be heard.
   * Status only becomes "speaking" once there is something to hear, so the caption stays honest.
   */
  const openVoice = useCallback(
    (geminiVoice?: string, onPlay?: () => void) => {
      stopSpeaking();
      const controller = new AbortController();
      speaking.current = controller;
      if (listener.current) listener.current.tutorSpeaking = true;
      // Wrapped so the stopwatch learns when a segment is really heard, which is after it has been
      // made and, if the reply ran ahead, after it was allowed - not when it was handed over.
      const base = buildPlayer(geminiVoice);
      const player: SpeechPlayer = onPlay
        ? {
            release: () => base.release(),
            async render(segment, signal) {
              const ready = await base.render(segment, signal);
              return {
                release: () => ready.release(),
                play: () => {
                  onPlay();
                  return ready.play();
                },
              };
            },
          }
        : base;
      const queue = speakInOrder(player, controller.signal);
      const done = queue.finished().finally(() => {
        if (speaking.current === controller) {
          speaking.current = null;
          if (listener.current) listener.current.tutorSpeaking = false;
          settle();
        }
      });
      return {
        controller,
        done,
        say(segment: SpeechSegment) {
          if (queue.pushed() === 0) setStatus("speaking");
          queue.push(segment);
        },
        spoken: queue.pushed,
        close: queue.close,
      };
    },
    [buildPlayer, stopSpeaking, setStatus, settle],
  );

  const say = useCallback(
    async (turn: ChatTurn) => {
      if (!turn.reply) return;
      const voice = openVoice();
      for (const segment of turn.reply.speech) voice.say(segment);
      voice.close();
      await voice.done;
    },
    [openVoice],
  );

  const startSession = useCallback(
    async (mode: TutorMode, scenarioId: string | null, topic: string | null, materialId: string | null) => {
      setError(null);
      setReview(null);
      setStatus("thinking");
      let created: Session;
      try {
        ({ session: created } = await api.post<{ session: Session }>("/api/session", { mode, scenarioId, topic, materialId }));
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
      const shown: ChatTurn = {
        id,
        clientTurnId: id,
        role: "student",
        text: trimmed,
        inputMethod,
        fluency: options.fluency,
        heard: options.heard,
        at: new Date().toISOString(),
      };
      setSession((s) => s && { ...s, turns: [...s.turns.filter((t) => !isReplaced(t)), shown] });

      // Opened before the request, so her sentences can be spoken as they arrive rather than after
      // the last one is written. An answer that supersedes this one also stops this one's voice.
      const voice = openVoice(undefined, () => {
        thinking.current?.cancel(); // she is talking now; stop humming over her
        options.clock?.mark("firstSound");
        options.clock?.mark("words");
      });
      options.signal?.addEventListener("abort", () => voice.controller.abort(), { once: true });

      let result: { studentTurn: ChatTurn; tutorTurn: ChatTurn } | null = null;
      try {
        for await (const line of api.postLines<TutorLine>(
          "/api/tutor",
          {
            sessionId: current.id,
            text: trimmed,
            inputMethod,
            fluency: options.fluency,
            heard: options.heard,
            clientTurnId: id,
            supersedes: options.supersedes,
          },
          options.signal,
        )) {
          if (line.type === "segment") {
            options.clock?.mark("firstSegment");
            voice.say(line.segment);
          }
          else if (line.type === "turn") result = { studentTurn: line.studentTurn, tutorTurn: line.tutorTurn };
          else if (line.type === "error") throw new Error(line.error);
        }
      } catch (e) {
        voice.controller.abort();
        voice.close();
        if (options.signal?.aborted) return; // the combined answer takes over
        if (pending.current?.ids.includes(id)) pending.current = null;
        setSession((s) => s && { ...s, turns: s.turns.filter((t) => t.id !== id) });
        setDraft(trimmed); // keep what they said so they can resend it
        setError(errorMessage(e));
        settle();
        return;
      }
      if (options.signal?.aborted) {
        voice.controller.abort();
        voice.close();
        return;
      }
      // A provider that can't stream says nothing until it is finished; speak the reply as it stands.
      if (result && voice.spoken() === 0) for (const segment of result.tutorTurn.reply?.speech ?? []) voice.say(segment);
      voice.close();

      if (pending.current?.ids.includes(id)) pending.current = null; // answered: no longer mergeable
      if (result) {
        const answered = result;
        setSession((s) => s && { ...s, turns: [...s.turns.filter((t) => t.id !== id && !isReplaced(t)), answered.studentTurn, answered.tutorTurn] });
      }
      await voice.done;
    },
    [openVoice, setStatus, settle],
  );

  // ---------------------------------------------------------------------------
  // Hands-free conversation
  // ---------------------------------------------------------------------------

  /** Abandons a transcription started during a pause the student then talked through. */
  const dropEarly = useCallback(() => {
    early.current?.controller.abort();
    early.current = null;
  }, []);

  /**
   * Starts transcribing as soon as the student pauses, on everything they have said so far.
   *
   * The pause that ends a turn is the same pause this fires on, so what is sent is almost always the
   * whole turn: by the time the pause has lasted long enough to be official, the transcript is most of
   * the way done. If they carry on, the work is thrown away - it is local, so it costs nothing but a
   * little idle GPU, and never a word of what they said.
   */
  const transcribeEarly = useCallback(
    (samples: Float32Array, sampleRate: number) => {
      if (!conversationRef.current?.earlyTranscribe || !sessionRef.current) return;
      dropEarly();
      const controller = new AbortController();
      const result = transcribeWhole(samples, sampleRate, controller.signal);
      result.catch(() => undefined); // held on the promise; whoever awaits it deals with it
      early.current = { samples: samples.length, sampleRate, result, controller };
      // What they have said is now known, so the pause can be made to fit the sentence. On a long turn
      // this lands after the turn is already over and changes nothing, which is why it only ever
      // shortens or lengthens the wait rather than ending the turn itself.
      void result
        .then((heard) => {
          const settings = conversationRef.current;
          if (!settings?.adaptivePause || !heard.text || controller.signal.aborted) return;
          listener.current?.update({ endSilenceMs: endpointFor(heard.text, settings.endSilenceMs).waitMs });
        })
        .catch(() => undefined);
    },
    [dropEarly],
  );

  /**
   * A finished spoken answer. If the previous answer is still being processed (the student paused,
   * then carried on), that processing was cancelled when they started again, and both parts are
   * sent together as one answer.
   */
  const handleUtterance = useCallback(
    async (samples: Float32Array, sampleRate: number, info: UtteranceInfo) => {
      const clock = startTurnClock();
      clock.endedAt(info.endSilenceMs);
      turnClock.current = clock;
      const audioSec = samples.length / sampleRate;

      const previous = pending.current;
      let audio = samples;
      let merged = false;
      if (previous) {
        previous.controller.abort();
        if (previous.sampleRate === sampleRate) {
          const startedAt = Date.now() - (samples.length / sampleRate) * 1000;
          const gapSec = Math.min(1, Math.max(0.3, (startedAt - previous.endedAt) / 1000));
          audio = concatAudio([previous.samples, new Float32Array(Math.round(gapSec * sampleRate)), samples]);
          merged = true;
        }
      }

      /**
       * Can the transcription started during the pause be used? Only if it covers this same recording.
       * It was taken a quarter of a second into the pause and this one is trimmed to a third, so the
       * difference is a sliver of silence, which cannot change a word. Anything more means they went
       * on talking after it was taken, and it describes only part of the answer.
       */
      const started = early.current;
      const sameRecording =
        started !== null &&
        !merged &&
        started.sampleRate === sampleRate &&
        Math.abs(started.samples - audio.length) / sampleRate < 0.5;
      early.current = null;
      if (started && !sameRecording) {
        started.controller.abort();
        clock.restarted();
      }

      const replaces = previous?.ids ?? [];
      if (audio.length === 0) {
        pending.current = null;
        started?.controller.abort();
        return settle();
      }

      // A noise while she thinks, cancelled the moment there is something real to hear.
      if (conversationRef.current?.thinkingSound) thinking.current?.schedule();

      const id = crypto.randomUUID();
      const controller = new AbortController();
      pending.current = { samples: audio, sampleRate, ids: [...replaces, id], controller, endedAt: Date.now() };
      if (replaces.length) setSession((s) => s && { ...s, turns: s.turns.filter((t) => !replaces.includes(t.clientTurnId ?? t.id)) });
      setStatus("transcribing");
      try {
        const heard = sameRecording && started ? await started.result : await transcribeWhole(audio, sampleRate, controller.signal);
        if (controller.signal.aborted) return;
        clock.mark("transcribed");
        if (!heard.text) {
          pending.current = null;
          setError(NOT_CAUGHT);
          return settle();
        }
        const sessionId = sessionRef.current?.id ?? "";
        await send(heard.text, "voice", { fluency: heard.fluency, heard: heard.heard, clientTurnId: id, supersedes: replaces, signal: controller.signal, clock });
        if (!controller.signal.aborted) clock.save({ model: health?.tutor.model ?? "", audioSec, early: Boolean(sameRecording), sessionId });
      } catch (e) {
        if (controller.signal.aborted) return;
        pending.current = null;
        setError(errorMessage(e));
        settle();
      }
    },
    [health, send, setStatus, settle],
  );

  useEffect(() => {
    listenerEvents.current = {
      // The student started talking: stop her voice, pause any processing, and listen.
      // A sound has started. Stopping her talking happens at once, because an interruption that is
      // not instant is not an interruption - but nothing is thrown away yet, because this fires on a
      // knock or a breath just as readily as on a word.
      speechStart: () => {
        if (speaking.current) stopSpeaking();
        thinking.current?.cancel();
        // Back to the pause they asked for; what they say may shorten or lengthen it again.
        if (conversationRef.current) listener.current?.update({ endSilenceMs: conversationRef.current.endSilenceMs });
        setError(null);
        setStatus("hearing");
      },
      // It really is speech. Now the reply being made for the last turn is worth abandoning.
      speechConfirmed: () => {
        pending.current?.controller.abort();
        dropEarly();
      },
      utterance: (samples, rate, info) => void handleUtterance(samples, rate, info),
      early: (samples, rate) => transcribeEarly(samples, rate),
      // Just a noise. If that noise interrupted an answer in progress, send that answer again.
      discard: () => {
        const previous = pending.current;
        dropEarly();
        if (previous?.controller.signal.aborted) {
          void handleUtterance(new Float32Array(0), previous.sampleRate, { endSilenceMs: 0, voicedSec: 0 });
        } else settle();
      },
    };
  }, [dropEarly, handleUtterance, transcribeEarly, stopSpeaking, setStatus, settle]);

  useEffect(() => {
    if (!handsFree || !conversation) return;
    const created = new VoiceActivityListener({
      endSilenceMs: conversation.endSilenceMs,
      sensitivity: conversation.sensitivity,
      level,
      meter: meter.current,
      onSpeechStart: () => listenerEvents.current.speechStart(),
      onSpeechConfirmed: () => listenerEvents.current.speechConfirmed(),
      onUtterance: (samples, rate, info) => listenerEvents.current.utterance(samples, rate, info),
      onDiscard: () => listenerEvents.current.discard(),
      onEarly: (samples, rate) => listenerEvents.current.early(samples, rate),
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
      await send(heard.text, "voice", { fluency: heard.fluency, heard: heard.heard });
    } catch (e) {
      setError(errorMessage(e));
      setStatus("idle");
    }
  }, [isRecording, stopRecording, send, setStatus]);

  const toggleMic = () => void (wantsMic.current ? stopListening() : startListening());

  /**
   * Hands-free waits for a pause to decide you've finished, and that pause is dead time on every
   * turn. A tap of Space says so outright. It is the same key that holds the microphone open in
   * push-to-talk, so there is one key for "this is my turn" either way - and a button you have to
   * find with the mouse is no use while you are in the middle of speaking French.
   */
  useEffect(() => {
    if (!active || !handsFree) return;
    const typing = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable);
    const done = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || typing(e.target)) return;
      e.preventDefault(); // Space would otherwise scroll the page
      listener.current?.finishNow();
    };
    window.addEventListener("keydown", done);
    return () => window.removeEventListener("keydown", done);
  }, [active, handsFree]);

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

  /**
   * The quick switch beside the transcript. It lists every voice, because leaving one out here is
   * worse than it sounds: the buttons write straight to the saved settings, so a picker that only
   * knew two of them would quietly downgrade a voice chosen on the Settings page.
   */
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
      const voice = openVoice(geminiVoice);
      for (const segment of VOICE_SAMPLE) voice.say(segment);
      voice.close();
      await voice.done;
    },
    [openVoice],
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
        <AvatarStage name={tutorName} state={status} level={level} avatar={health?.avatar} videoRef={avatarVideo} />
        {session ? (
          <div className="stage-controls">
            <p className="session-tag">
              {MODE_LABELS[session.mode].title}
              {/* A chosen lesson carries its brief in the topic too; the header only wants the name. */}
              {scenario ? ` · ${scenario.title}` : session.topic ? ` · ${session.topic.split(" - ")[0]}` : ""}
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
          <SessionPicker busy={busy} onStart={(m, s, t, mat) => void startSession(m, s, t, mat)} />
        )}
        <div className="voice-picker">
          <div className="voice-toggle" role="radiogroup" aria-label="Tutor voice">
            <span className="voice-toggle__label">Voice</span>
            {VOICE_PICKS.map((pick) => (
              <button
                key={pick.provider}
                className="seg-btn"
                role="radio"
                aria-checked={voice.provider === pick.provider}
                title={pick.hint}
                onClick={() => changeVoice({ provider: pick.provider })}
                disabled={pick.provider === "gemini" && health?.gemini === false}
              >
                {pick.label}
              </button>
            ))}
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
                {(["higher", "lower"] as VoiceRegister[]).map((register) => (
                  <optgroup key={register} label={`${VOICE_REGISTERS[register].label} (${VOICE_REGISTERS[register].hint})`}>
                    {GEMINI_VOICES.filter((v) => voiceRegister(v.hz) === register).map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name} · {v.style} · {v.hz} Hz
                      </option>
                    ))}
                  </optgroup>
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
            <button className="btn" onClick={() => listener.current?.finishNow()} title="Send straight away instead of waiting for the pause">
              I&rsquo;ve finished <kbd>Space</kbd>
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

/** The grammar list, in the order a learner meets it. */
const TOPIC_GROUPS: [CefrLevel, typeof GRAMMAR_TOPICS][] = (["A2", "B1", "B2"] as CefrLevel[])
  .map((level): [CefrLevel, typeof GRAMMAR_TOPICS] => [level, GRAMMAR_TOPICS.filter((t) => t.level === level)])
  .filter(([, topics]) => topics.length > 0);

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

/** A saved text, as the list sends it: everything but the text itself, which is only needed server-side. */
type MaterialSummary = Omit<Material, "text"> & { preview: string };

function SessionPicker({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: (mode: TutorMode, scenarioId: string | null, topic: string | null, materialId: string | null) => void;
}) {
  const [mode, setMode] = useState<TutorMode>("conversation");
  const [scenarioId, setScenarioId] = useState(ROLEPLAY_SCENARIOS[0].id);
  const [topicId, setTopicId] = useState(GRAMMAR_TOPICS[0].id);
  const [topic, setTopic] = useState("");
  const [mistakes, setMistakes] = useState<Record<string, number>>({});
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [materialId, setMaterialId] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", text: "" });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const usesMaterial = mode === "conversation" || mode === "lesson" || mode === "oral_quiz";

  useEffect(() => {
    api
      .get<{ materials: MaterialSummary[] }>("/api/material")
      .then((r) => setMaterials(r.materials))
      .catch(() => undefined);
  }, []);

  const saveMaterial = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const { material } = await api.post<{ material: MaterialSummary }>("/api/material", draft);
      setMaterials((list) => [material, ...list]);
      setMaterialId(material.id);
      setDraft({ title: "", text: "" });
      setAdding(false);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const removeMaterial = async (id: string) => {
    setMaterials((list) => list.filter((m) => m.id !== id));
    if (materialId === id) setMaterialId("");
    await api.del(`/api/material?id=${encodeURIComponent(id)}`).catch(() => undefined);
  };
  const scenario = ROLEPLAY_SCENARIOS.find((s) => s.id === scenarioId);
  const grammar = GRAMMAR_TOPICS.find((t) => t.id === topicId);

  // Only when a lesson is actually being chosen: how often each kind of mistake has been made, so
  // the list can say where the student's own trouble is rather than just listing the syllabus.
  useEffect(() => {
    if (mode !== "lesson" || Object.keys(mistakes).length) return;
    api
      .get<{ categories: { category: string; count: number }[] }>("/api/progress")
      .then((r) => setMistakes(Object.fromEntries(r.categories.map((c) => [c.category, c.count]))))
      .catch(() => undefined);
  }, [mode, mistakes]);

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
      {mode === "lesson" && (
        <label className="field">
          <span>What shall we work on?</span>
          <select className="input" value={topicId} onChange={(e) => setTopicId(e.target.value)}>
            {TOPIC_GROUPS.map(([level, topics]) => (
              <optgroup key={level} label={level}>
                {topics.map((t) => {
                  const n = mistakes[t.category] ?? 0;
                  return (
                    <option key={t.id} value={t.id}>
                      {t.title}
                      {/* The count is for the whole area, which several lessons can share - so say so. */}
                      {n > 0 ? ` — ${n} mistake${n === 1 ? "" : "s"} in this area` : ""}
                    </option>
                  );
                })}
              </optgroup>
            ))}
            <optgroup label="Your own">
              <option value={CUSTOM_TOPIC_ID}>Something else…</option>
            </optgroup>
          </select>
          {grammar && <span className="small">{grammar.brief}</span>}
        </label>
      )}
      {(mode === "conversation" || (mode === "lesson" && topicId === CUSTOM_TOPIC_ID) || mode === "roleplay") && (
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
      {usesMaterial && (
        <div className="field">
          <span>Work from a text you&rsquo;ve shared (optional)</span>
          <div className="row">
            <select className="input" value={materialId} onChange={(e) => setMaterialId(e.target.value)} disabled={adding}>
              <option value="">Nothing — just talk</option>
              {materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} · {m.words} words
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--ghost" onClick={() => setAdding((a) => !a)}>
              {adding ? "Cancel" : "Add a text"}
            </button>
            {materialId && !adding && (
              <button type="button" className="btn btn--ghost" onClick={() => void removeMaterial(materialId)} title="Remove this text from your library">
                Remove
              </button>
            )}
          </div>
          {adding ? (
            <>
              <input className="input" placeholder="A name for it (optional)" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
              <textarea
                className="input"
                rows={7}
                placeholder="Paste an article, an email, a transcript — anything you want to talk about in French."
                value={draft.text}
                onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              />
              <div className="row">
                <button type="button" className="btn" disabled={saving || !draft.text.trim()} onClick={() => void saveMaterial()}>
                  {saving ? "Saving…" : "Save it"}
                </button>
                <span className="small muted">
                  {draft.text.length.toLocaleString()} / {MATERIAL_MAX_CHARS.toLocaleString()} characters
                </span>
              </div>
            </>
          ) : (
            materialId && <span className="small">{materials.find((m) => m.id === materialId)?.preview}…</span>
          )}
          {problem && <span className="small alert">{problem}</span>}
        </div>
      )}
      <button
        className="btn btn--primary"
        disabled={busy || ((mode === "roleplay" ? scenarioId === CUSTOM_SCENARIO_ID : mode === "lesson" && topicId === CUSTOM_TOPIC_ID) && !topic.trim())}
        onClick={() =>
          onStart(
            mode,
            mode === "roleplay" ? scenarioId : null,
            // A chosen lesson travels as its name plus what it covers, so she teaches this corner of
            // the grammar and not the whole tense. The session prompt reads topic and needs no change.
            mode === "lesson" && grammar ? `${grammar.title} - ${grammar.brief}` : topic.trim() || null,
            usesMaterial ? materialId || null : null,
          )
        }
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
  if (health.voiceServer && !health.voiceServer.online) {
    issues.push(
      health.voiceServer?.starting
        ? "Her voice is still loading, so the browser voice is used for the moment."
        : health.voiceServer?.problem
          ? `Her voice can't start: ${health.voiceServer.problem}`
          : `The local voice server isn't running, so the browser voice is used instead. Run "npm run ${health.voice.provider === "piper" ? "piper" : "voice"}", or choose another voice in Settings.`,
    );
  }
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

/**
 * What to say about the language of a recording, when there is anything to say. A confident French
 * reading is the normal case and needs no remark; the other two explain a transcript that doesn't
 * match what you said.
 */
function heardNote(heard: ChatTurn["heard"]): string | null {
  if (!heard) return null;
  if (!heard.certain) return "language unclear";
  return heard.language === "en" ? "heard as English" : null;
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
                {heardNote(turn.heard) && ` · ${heardNote(turn.heard)}`}
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
