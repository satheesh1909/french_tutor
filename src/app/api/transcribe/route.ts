import { NextResponse } from "next/server";
import { fluencyFromTiming, fluencyFromWords, parseSpeechTiming } from "@/lib/fluency";
import { errorResponse } from "@/lib/http";
import { keepRecording } from "@/lib/recordings";
import { transcribe } from "@/lib/providers/gemini";
import { whisperTranscribe } from "@/lib/providers/whisper";
import { readSettings } from "@/lib/store";
import type { HeardLanguage } from "@/lib/types";

const MAX_BYTES = 12 * 1024 * 1024; // about six minutes of 16 kHz speech

/**
 * Receives a WAV recording and returns what the student said (mistakes included) plus their
 * speaking speed. Whisper's word timings give the most precise speed; without them, the browser's
 * own measurement of when the student was talking (the x-speech-timing header) is used.
 *
 * `?language=` names the language instead of letting Whisper detect it, which is a second pass over
 * the audio. Only pass it when it is genuinely known: a wrong name is transcribed as fluent nonsense.
 */
export async function POST(req: Request) {
  try {
    const asked = new URL(req.url).searchParams.get("language");
    const hint = asked === "fr" || asked === "en" ? asked : undefined;
    const audio = Buffer.from(await req.arrayBuffer());
    if (audio.length < 2_000) return NextResponse.json({ error: "The recording was empty." }, { status: 400 });
    if (audio.length > MAX_BYTES) {
      return NextResponse.json({ error: "That recording is too long. Keep each turn under a few minutes." }, { status: 413 });
    }

    const { transcription } = await readSettings();
    const whisperOnly = transcription.engine === "whisper";
    // Both run at once, so timing with Whisper doesn't slow the turn down.
    const [geminiText, whisper] = await Promise.all([
      whisperOnly ? null : transcribe(audio, transcription.model),
      whisperOnly || transcription.whisperTiming
        ? whisperTranscribe(audio, hint).catch((err) => {
            if (whisperOnly) throw err;
            return null; // timing is a bonus when Gemini does the words
          })
        : null,
    ]);

    const text = (whisperOnly ? whisper?.text : geminiText) ?? "";
    const timing = parseSpeechTiming(req.headers.get("x-speech-timing"));
    // Whisper's own text goes with its timings: it hears one language per recording, so an English
    // aside that Gemini transcribed isn't in Whisper's timed span and mustn't inflate the rate.
    const fluency = (whisper && fluencyFromWords(whisper.text, whisper.words)) ?? (timing && fluencyFromTiming(text, timing)) ?? null;

    // Worth saying out loud: an unclear recording is transcribed anyway, and a wrong language reads as
    // confident gibberish rather than as a failure, so the turn carries the doubt with it.
    const spoken = whisper?.language;
    const heard: HeardLanguage | null = spoken === "fr" || spoken === "en" ? { language: spoken, certain: whisper?.certain === true } : null;
    if (heard && !heard.certain) {
      console.warn(
        `That recording didn't sound like French or English (margin ${whisper?.margin}, likelihood ${whisper?.likelihood}, ` +
          `Whisper's own guess "${whisper?.detected}"); transcribed it as ${heard.language} anyway.`,
      );
    }

    // Kept after the answer is ready, so writing it can't delay her reply.
    keepRecording(audio, {
      text,
      heard,
      fluency,
      engine: whisperOnly ? "whisper" : "gemini",
      model: whisperOnly ? "whisper" : transcription.model,
    });

    return NextResponse.json({ text, fluency, heard });
  } catch (err) {
    return errorResponse(err);
  }
}
