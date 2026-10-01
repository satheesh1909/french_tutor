import { GEMINI_VOICES, SPEECH_SPEED_RANGE, type SpeechSegment, type VoiceProvider, type VoiceSettings } from "../types";
import { synthesize as geminiSynthesize } from "./gemini";
import { piperSynthesize } from "./piper";
import { xttsSynthesize } from "./xtts";

/**
 * Who is speaking, for the two routes that need her voice on the server (/api/tts and /api/avatar).
 * Keeping it in one shape means the cache can tell one voice's clips from another's.
 */
export interface VoiceChoice {
  provider: VoiceProvider;
  /** Gemini's TTS model. The local voice ignores it. */
  model: string;
  /** A Gemini voice name, an XTTS speaker, or Piper's two voices joined. The cache keys on this. */
  voice: string;
  /** Piper only, which needs one voice per language. */
  voices?: { fr: string; en: string };
  /** Piper only: how fast she speaks each language. Part of `voice` too, so the cache can tell paces apart. */
  speeds?: { fr: number; en: number };
}

/**
 * What the request asked for, narrowed to something we are willing to do. The Settings page previews
 * a voice before it is saved, so a request may name one; anything unrecognised falls back to the
 * saved setting rather than failing, because a mistyped voice shouldn't leave her mute.
 */
export function resolveVoice(body: Record<string, unknown>, saved: VoiceSettings): VoiceChoice {
  const wanted = body.provider;
  // "browser" is spoken by the browser itself and never reaches here; when that is the saved choice,
  // these routes still need some voice, and Gemini is the one that needs no local server.
  const provider: VoiceProvider =
    wanted === "gemini" || wanted === "xtts" || wanted === "piper"
      ? wanted
      : saved.provider === "browser"
        ? "gemini"
        : saved.provider;

  if (provider === "piper") {
    const named = (body.voices ?? {}) as Record<string, unknown>;
    const one = (key: "fr" | "en", fallback: string) =>
      typeof named[key] === "string" && (named[key] as string).trim() ? (named[key] as string).trim().slice(0, 120) : fallback;
    const voices = { fr: one("fr", saved.piperVoiceFr), en: one("en", saved.piperVoiceEn) };
    const asked = (body.speeds ?? {}) as Record<string, unknown>;
    const pace = (key: "fr" | "en", fallback: number) =>
      typeof asked[key] === "number" && Number.isFinite(asked[key])
        ? Math.min(SPEECH_SPEED_RANGE.max, Math.max(SPEECH_SPEED_RANGE.min, asked[key] as number))
        : fallback;
    const speeds = { fr: pace("fr", saved.piperSpeedFr), en: pace("en", saved.piperSpeedEn) };
    // The pace belongs in the name, or a slower voice would replay the clips the quick one cached.
    return { provider, model: "", voice: `${voices.fr}@${speeds.fr}+${voices.en}@${speeds.en}`, voices, speeds };
  }
  if (provider === "xtts") {
    const speaker = typeof body.speaker === "string" && body.speaker.trim() ? body.speaker.trim().slice(0, 120) : saved.xttsSpeaker;
    return { provider, model: "", voice: speaker };
  }
  return {
    provider: "gemini",
    model: typeof body.model === "string" && /^gemini-[\w.-]+$/.test(body.model) ? body.model : saved.geminiModel,
    voice: GEMINI_VOICES.some((v) => v.name === body.voice) ? (body.voice as string) : saved.geminiVoice,
  };
}

/** Her voice for these words, from whichever provider was chosen. */
export function synthesizeWith(segments: SpeechSegment[], choice: VoiceChoice): Promise<Buffer> {
  if (choice.provider === "piper") return piperSynthesize(segments, choice.voices ?? { fr: "", en: "" }, choice.speeds);
  if (choice.provider === "xtts") return xttsSynthesize(segments, choice.voice);
  return geminiSynthesize(segments, { model: choice.model, voice: choice.voice });
}
