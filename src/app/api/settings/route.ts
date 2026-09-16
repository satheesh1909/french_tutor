import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { hasClaudeCredentials, listClaudeModels } from "@/lib/providers/claude";
import { hasGeminiKey, listGeminiModels } from "@/lib/providers/gemini";
import { listOllamaModels } from "@/lib/providers/ollama";
import { whisperStatus } from "@/lib/providers/whisper";
import { readSettings, withLock, writeSettings } from "@/lib/store";
import {
  BRAIN_JOBS,
  EFFORTS,
  GEMINI_VOICES,
  PROVIDERS,
  type AppSettings,
  type Effort,
  type ModelChoice,
  type Provider,
  type SettingsOptions,
} from "@/lib/types";

type ModelLists = Omit<SettingsOptions, "whisper">;

// Listing models means calling three services, so keep the answer for a few minutes.
let cachedOptions: { at: number; options: ModelLists } | undefined;

async function loadOptions(): Promise<SettingsOptions> {
  // The Whisper server is started and stopped by hand, so always check it fresh.
  const [lists, whisper] = await Promise.all([loadModelLists(), whisperStatus()]);
  return { ...lists, whisper };
}

async function loadModelLists(): Promise<ModelLists> {
  if (cachedOptions && Date.now() - cachedOptions.at < 5 * 60_000) return cachedOptions.options;
  const [claudeModels, geminiModels, ollamaModels] = await Promise.all([
    listClaudeModels().catch((err) => (console.warn("Couldn't list Claude models", err), [])),
    listGeminiModels().catch((err) => (console.warn("Couldn't list Gemini models", err), { text: [], tts: [], transcribe: [] })),
    listOllamaModels().catch(() => null),
  ]);
  const options: ModelLists = {
    claude: { connected: hasClaudeCredentials(), models: claudeModels },
    gemini: { connected: hasGeminiKey(), ...geminiModels },
    ollama: {
      online: ollamaModels !== null,
      chat: (ollamaModels ?? []).filter((m) => m.capabilities.includes("completion")),
      embedding: (ollamaModels ?? []).filter((m) => m.capabilities.includes("embedding")),
    },
  };
  // Don't cache a failed lookup: the user may be about to start Ollama or add a key.
  if (options.ollama.online && (claudeModels.length || !options.claude.connected)) cachedOptions = { at: Date.now(), options };
  return options;
}

/** `?options=false` skips the model lists (used by pages that only need the current settings). */
export async function GET(req: Request) {
  try {
    const withOptions = new URL(req.url).searchParams.get("options") !== "false";
    const settings = await readSettings();
    return NextResponse.json(withOptions ? { settings, options: await loadOptions() } : { settings });
  } catch (err) {
    return errorResponse(err);
  }
}

const text = (value: unknown, fallback: string, max = 120) =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : fallback;

function choice(input: unknown, current: ModelChoice): ModelChoice {
  const c = (input ?? {}) as Partial<Record<keyof ModelChoice, unknown>>;
  return {
    provider: PROVIDERS.includes(c.provider as Provider) ? (c.provider as Provider) : current.provider,
    model: text(c.model, current.model),
    effort: EFFORTS.includes(c.effort as Effort) ? (c.effort as Effort) : current.effort,
  };
}

/** Accepts a partial update and merges it into the saved settings. */
export async function PUT(req: Request) {
  try {
    const input = (await req.json().catch(() => ({}))) as Partial<Record<keyof AppSettings, Record<string, unknown>>>;
    const settings = await withLock(async () => {
      const current = await readSettings();
      const models = { ...current.models };
      for (const job of BRAIN_JOBS) models[job] = choice(input.models?.[job], current.models[job]);
      const v = input.voice ?? {};
      const t = input.transcription ?? {};
      const next: AppSettings = {
        models,
        transcription: {
          engine: t.engine === "gemini" || t.engine === "whisper" ? t.engine : current.transcription.engine,
          model: text(t.model, current.transcription.model),
          whisperTiming: typeof t.whisperTiming === "boolean" ? t.whisperTiming : current.transcription.whisperTiming,
        },
        memory: {
          enabled: typeof input.memory?.enabled === "boolean" ? input.memory.enabled : current.memory.enabled,
          model: text(input.memory?.model, current.memory.model),
        },
        voice: {
          provider: v.provider === "gemini" || v.provider === "browser" ? v.provider : current.voice.provider,
          geminiModel: text(v.geminiModel, current.voice.geminiModel),
          geminiVoice: GEMINI_VOICES.some((g) => g.name === v.geminiVoice) ? (v.geminiVoice as string) : current.voice.geminiVoice,
          // Empty string is meaningful here: "choose automatically".
          browserVoiceEn: typeof v.browserVoiceEn === "string" ? v.browserVoiceEn.slice(0, 200) : current.voice.browserVoiceEn,
          browserVoiceFr: typeof v.browserVoiceFr === "string" ? v.browserVoiceFr.slice(0, 200) : current.voice.browserVoiceFr,
        },
        updatedAt: new Date().toISOString(),
      };
      await writeSettings(next);
      return next;
    });
    return NextResponse.json({ settings });
  } catch (err) {
    return errorResponse(err);
  }
}
