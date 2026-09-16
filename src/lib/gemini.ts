import { GoogleGenAI, Modality } from "@google/genai";
import { config } from "./config";
import { quizPrompt } from "./prompts";
import { pcm16Silence, pcm16ToWav } from "./wav";
import {
  ERROR_CATEGORIES,
  type ErrorCategory,
  type Lang,
  type LearnerProfile,
  type MistakeRecord,
  type QuizQuestion,
  type ReviewCard,
  type SpeechSegment,
} from "./types";

let client: GoogleGenAI | undefined;
const gemini = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY }));

export const hasGeminiKey = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

// ---------------------------------------------------------------------------
// Ears: speech → text
// ---------------------------------------------------------------------------

/**
 * Verbatim mode matters: "smart" transcription cleans up grammar, which would hide exactly
 * the mistakes the tutor needs to hear.
 */
export async function transcribe(wav: Buffer): Promise<string> {
  const interaction = await gemini().interactions.create({
    model: config.gemini.transcribeModel,
    input: [{ type: "audio", data: wav.toString("base64"), mime_type: "audio/wav" }],
    generation_config: { transcription_config: { mode: "verbatim", language_codes: ["fr-FR", "en-GB"] } },
  });
  return (interaction.output_text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Voice: text → speech
// ---------------------------------------------------------------------------

// Director's notes keep one voice sounding British in English and native in French.
const DIRECTION: Record<Lang, string> = {
  en: "Say this in a warm, clear, friendly British English accent, at a relaxed teaching pace:",
  fr: "Dis ceci avec un accent français natif et naturel, d'une voix chaleureuse, clairement et un peu lentement :",
};

function mergeSameLanguage(segments: SpeechSegment[]): SpeechSegment[] {
  const merged: SpeechSegment[] = [];
  for (const s of segments) {
    const last = merged.at(-1);
    if (last && last.lang === s.lang) last.text = `${last.text} ${s.text}`;
    else merged.push({ ...s });
  }
  return merged;
}

async function speakSegment(segment: SpeechSegment): Promise<{ pcm: Buffer; sampleRate: number }> {
  const response = await gemini().models.generateContent({
    model: config.gemini.ttsModel,
    contents: [{ parts: [{ text: `${DIRECTION[segment.lang]}\n${segment.text}` }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.gemini.ttsVoice } } },
    },
  });
  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("Gemini returned no audio.");
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24_000;
  return { pcm: Buffer.from(part.inlineData.data, "base64"), sampleRate: rate };
}

/** Speaks each language segment with the right accent, then joins them into one WAV clip. */
export async function synthesize(segments: SpeechSegment[]): Promise<Buffer> {
  const clips = await Promise.all(mergeSameLanguage(segments).map(speakSegment));
  const sampleRate = clips[0].sampleRate;
  const pause = pcm16Silence(180, sampleRate);
  const pcm = Buffer.concat(clips.flatMap((c, i) => (i === 0 ? [c.pcm] : [pause, c.pcm])));
  return pcm16ToWav(pcm, sampleRate);
}

// ---------------------------------------------------------------------------
// Quiz writer
// ---------------------------------------------------------------------------

const QUIZ_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["multiple_choice", "fill_blank", "translate"] },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answer: { type: "string" },
          acceptedAnswers: { type: "array", items: { type: "string" } },
          explanation: { type: "string" },
          category: { type: "string", enum: [...ERROR_CATEGORIES] },
        },
        required: ["type", "question", "options", "answer", "acceptedAnswers", "explanation", "category"],
      },
    },
  },
  required: ["questions"],
};

export async function generateQuiz(profile: LearnerProfile, mistakes: MistakeRecord[], vocab: ReviewCard[], count: number): Promise<QuizQuestion[]> {
  const response = await gemini().models.generateContent({
    model: config.gemini.textModel,
    contents: quizPrompt(profile, mistakes, vocab, count),
    config: { responseMimeType: "application/json", responseJsonSchema: QUIZ_SCHEMA },
  });

  const parsed = JSON.parse(response.text ?? "{}") as { questions?: Omit<QuizQuestion, "id">[] };
  return (parsed.questions ?? [])
    .filter((q) => q.question && q.answer && ERROR_CATEGORIES.includes(q.category as ErrorCategory))
    .filter((q) => q.type !== "multiple_choice" || q.options.includes(q.answer))
    .map((q) => ({
      ...q,
      id: crypto.randomUUID(),
      options: q.type === "multiple_choice" ? q.options : [],
      acceptedAnswers: [...new Set([q.answer, ...q.acceptedAnswers])],
    }));
}
