import { config } from "../config";
import type { WordTiming } from "../fluency";
import { UserFacingError } from "../http";
import { recordUsage } from "../usage";

// Talks to the local faster-whisper server in whisper_server/server.py.

export interface WhisperResult {
  text: string;
  language: string;
  /** How far ahead the chosen language was of the other one, 0-1. */
  margin: number;
  /** How likely the chosen language was among all the languages Whisper knows, 0-1. */
  likelihood: number;
  /** False when the recording didn't convincingly sound like either French or English. */
  certain: boolean;
  /** What Whisper would have picked unconstrained. Only for explaining a turn that went wrong. */
  detected: string | null;
  duration: number;
  words: (WordTiming & { word: string })[];
}

export async function whisperTranscribe(wav: Buffer): Promise<WhisperResult> {
  let res: Response;
  try {
    res = await fetch(`${config.whisper.url}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new UserFacingError('The local Whisper server isn\'t running. Start it with "npm run whisper", or switch transcription to Gemini in Settings.', 503);
  }
  const data = (await res.json().catch(() => ({}))) as Partial<WhisperResult> & {
    error?: string;
    tokens?: number;
    model?: string;
    languageMargin?: number;
    languageLikelihood?: number;
    languageCertain?: boolean;
    languageDetected?: string | null;
  };
  if (!res.ok) throw new UserFacingError(data.error ?? `Whisper failed (${res.status}).`, 502);

  // Whisper reads audio rather than text tokens, so only its output tokens are counted.
  recordUsage({ provider: "whisper", model: data.model ?? "whisper", feature: "transcription", output: data.tokens ?? 0 });
  return {
    text: data.text ?? "",
    language: data.language ?? "",
    margin: data.languageMargin ?? 0,
    likelihood: data.languageLikelihood ?? 0,
    certain: data.languageCertain ?? false,
    detected: data.languageDetected ?? null,
    duration: data.duration ?? 0,
    words: data.words ?? [],
  };
}

export async function whisperStatus(): Promise<{ online: boolean; model: string | null; device: string | null }> {
  try {
    const res = await fetch(`${config.whisper.url}/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return { online: false, model: null, device: null };
    const data = (await res.json()) as { model?: string; device?: string };
    return { online: true, model: data.model ?? null, device: data.device ?? null };
  } catch {
    return { online: false, model: null, device: null };
  }
}
