import { GoogleGenAI, Modality, type GenerateContentResponseUsageMetadata } from "@google/genai";
import type { z } from "zod";
import { jsonSchemaFor, type StructuredRequest } from "../structured";
import type { Lang, SpeechSegment, UsageFeature } from "../types";
import { recordUsage } from "../usage";
import { pcm16Silence, pcm16ToWav } from "../wav";

let client: GoogleGenAI | undefined;
const gemini = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY }));

export const hasGeminiKey = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);

function recordGeminiUsage(model: string, feature: UsageFeature, usage: GenerateContentResponseUsageMetadata | undefined) {
  recordUsage({
    provider: "gemini",
    model,
    feature,
    input: usage?.promptTokenCount ?? 0,
    cached: usage?.cachedContentTokenCount ?? 0,
    output: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  });
}

// ---------------------------------------------------------------------------
// Brain: structured replies
// ---------------------------------------------------------------------------

export async function geminiStructured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
  const response = await gemini().models.generateContent({
    model: req.model,
    contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.parts.join("\n\n") }] })),
    config: {
      systemInstruction: req.system,
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchemaFor(req.schema),
    },
  });
  recordGeminiUsage(req.model, req.feature, response.usageMetadata);
  return req.schema.parse(JSON.parse(response.text ?? "")) as z.infer<T>;
}

// ---------------------------------------------------------------------------
// Ears: speech → text
// ---------------------------------------------------------------------------

/**
 * Verbatim mode matters: "smart" transcription cleans up grammar, which would hide exactly
 * the mistakes the tutor needs to hear.
 */
export async function transcribe(wav: Buffer, model: string): Promise<string> {
  const interaction = await gemini().interactions.create({
    model,
    input: [{ type: "audio", data: wav.toString("base64"), mime_type: "audio/wav" }],
    generation_config: { transcription_config: { mode: "verbatim", language_codes: ["fr-FR", "en-GB"] } },
  });
  recordUsage({
    provider: "gemini",
    model,
    feature: "transcription",
    input: interaction.usage?.total_input_tokens ?? 0,
    cached: interaction.usage?.total_cached_tokens ?? 0,
    output: interaction.usage?.total_output_tokens ?? 0,
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

async function speakSegment(segment: SpeechSegment, model: string, voice: string): Promise<{ pcm: Buffer; sampleRate: number }> {
  const response = await gemini().models.generateContent({
    model,
    contents: [{ parts: [{ text: `${DIRECTION[segment.lang]}\n${segment.text}` }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  recordGeminiUsage(model, "voice", response.usageMetadata);
  const part = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("Gemini returned no audio.");
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1]) || 24_000;
  return { pcm: Buffer.from(part.inlineData.data, "base64"), sampleRate: rate };
}

/** Speaks each language segment with the right accent, then joins them into one WAV clip. */
export async function synthesize(segments: SpeechSegment[], options: { model: string; voice: string }): Promise<Buffer> {
  const clips = await Promise.all(mergeSameLanguage(segments).map((s) => speakSegment(s, options.model, options.voice)));
  const sampleRate = clips[0].sampleRate;
  const pause = pcm16Silence(180, sampleRate);
  const pcm = Buffer.concat(clips.flatMap((c, i) => (i === 0 ? [c.pcm] : [pause, c.pcm])));
  return pcm16ToWav(pcm, sampleRate);
}

// ---------------------------------------------------------------------------
// Model lists for the Settings page
// ---------------------------------------------------------------------------

const NOT_FOR_TEXT = /image|live|embedding|robotics|computer-use|native-audio|customtools|omni|translate|tts|transcribe/;

export async function listGeminiModels(): Promise<{ text: string[]; tts: string[]; transcribe: string[] }> {
  if (!hasGeminiKey()) return { text: [], tts: [], transcribe: [] };
  const names: string[] = [];
  const pager = await gemini().models.list({ config: { pageSize: 200 } });
  for await (const m of pager) {
    if (m.name && (m.supportedActions ?? []).includes("generateContent")) names.push(m.name.replace(/^models\//, ""));
  }
  const gem = names.filter((n) => n.startsWith("gemini"));
  return {
    text: gem.filter((n) => !NOT_FOR_TEXT.test(n)),
    tts: gem.filter((n) => n.includes("tts")),
    transcribe: gem.filter((n) => n.includes("transcribe")),
  };
}
