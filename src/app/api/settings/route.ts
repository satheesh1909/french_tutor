import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { listClaudeModels } from "@/lib/providers/claude";
import { listGeminiModels } from "@/lib/providers/gemini";
import { listOllamaModels } from "@/lib/providers/ollama";
import { whisperStatus } from "@/lib/providers/whisper";
import { piperStatus } from "@/lib/providers/piper";
import { xttsStatus } from "@/lib/providers/xtts";
import { keyStatuses, readSecrets, readSettings, withLock, writeSecrets, writeSettings } from "@/lib/store";
import {
  BRAIN_JOBS,
  EFFORTS,
  END_SILENCE_RANGE,
  AVATAR_MODES,
  GEMINI_VOICES,
  KEY_PROVIDERS,
  MIC_SENSITIVITIES,
  PROVIDERS,
  SPEECH_SPEED_RANGE,
  VOICE_PROVIDERS,
  type AppSettings,
  type AvatarMode,
  type Effort,
  type KeyProvider,
  type MicSensitivity,
  type ModelChoice,
  type Provider,
  type SettingsOptions,
  type VoiceProvider,
} from "@/lib/types";

type ModelLists = Omit<SettingsOptions, "whisper" | "xtts" | "piper">;

// Listing models means calling three services, so keep the answer for a few minutes.
let cachedOptions: { at: number; options: ModelLists } | undefined;

async function loadOptions(): Promise<SettingsOptions> {
  // The local servers are started and stopped by hand, so always check them fresh.
  const [lists, whisper, xtts, piper] = await Promise.all([loadModelLists(), whisperStatus(), xttsStatus(), piperStatus()]);
  return { ...lists, whisper, xtts, piper };
}

async function loadModelLists(): Promise<ModelLists> {
  if (cachedOptions && Date.now() - cachedOptions.at < 5 * 60_000) return cachedOptions.options;
  const [claudeModels, geminiModels, ollamaModels, keys] = await Promise.all([
    listClaudeModels().catch((err) => (console.warn("Couldn't list Claude models", err), [])),
    listGeminiModels().catch((err) => (console.warn("Couldn't list Gemini models", err), { text: [], tts: [], transcribe: [] })),
    listOllamaModels().catch(() => null),
    keyStatuses(),
  ]);
  const options: ModelLists = {
    claude: { connected: keys.claude.source !== "none", models: claudeModels },
    gemini: { connected: keys.gemini.source !== "none", ...geminiModels },
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
    const [settings, keys] = await Promise.all([readSettings(), keyStatuses()]);
    return NextResponse.json(withOptions ? { settings, keys, options: await loadOptions() } : { settings, keys });
  } catch (err) {
    return errorResponse(err);
  }
}

const text = (value: unknown, fallback: string, max = 120) =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : fallback;

/** A speaking speed the voice server will accept, rounded to the step the slider moves in. */
const speed = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(SPEECH_SPEED_RANGE.max, Math.max(SPEECH_SPEED_RANGE.min, value)) * 100) / 100
    : fallback;

/** A model has to be a plain https .glb/.gltf link; anything else keeps the current one. */
function avatarUrl(value: string, current: string): string {
  const url = value.trim();
  if (url === "") return "";
  return /^https:\/\/[^\s]+\.(glb|gltf)(\?[^\s]*)?$/i.test(url) && url.length <= 500 ? url : current;
}

function choice(input: unknown, current: ModelChoice): ModelChoice {
  const c = (input ?? {}) as Partial<Record<keyof ModelChoice, unknown>>;
  return {
    provider: PROVIDERS.includes(c.provider as Provider) ? (c.provider as Provider) : current.provider,
    model: text(c.model, current.model),
    effort: EFFORTS.includes(c.effort as Effort) ? (c.effort as Effort) : current.effort,
  };
}


/**
 * Saves API keys typed on the Settings page. An empty string clears one, which falls back to the
 * environment variable if there is one. The keys are never sent back to the browser.
 */
async function saveKeys(input: unknown): Promise<Partial<Record<KeyProvider, string>>> {
  const given = (input ?? {}) as Partial<Record<KeyProvider, unknown>> & { claudeWorkspace?: unknown };
  const changed: Partial<Record<KeyProvider, string>> = {};
  for (const provider of KEY_PROVIDERS) {
    const value = given[provider];
    if (typeof value === "string") changed[provider] = value.trim().slice(0, 300);
  }
  // Not a key, but it is saved beside one: an organisation key has to name its workspace.
  const workspace = typeof given.claudeWorkspace === "string" ? given.claudeWorkspace.trim().slice(0, 120) : undefined;
  if (Object.keys(changed).length === 0 && workspace === undefined) return changed;
  await withLock(async () => {
    const current = await readSecrets();
    await writeSecrets({
      ...current,
      ...(changed.claude === undefined ? {} : { anthropicApiKey: changed.claude }),
      ...(changed.gemini === undefined ? {} : { geminiApiKey: changed.gemini }),
      ...(workspace === undefined ? {} : { anthropicWorkspaceId: workspace }),
    });
  });
  cachedOptions = undefined; // the model lists depend on the keys
  return changed;
}

/** Turns a provider error into something worth reading. */
function keyProblem(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/401|authentication|api[ _-]?key[ _-]?(is )?(invalid|not valid)/i.test(raw)) return "That key was refused. Check you pasted all of it, with no stray spaces.";
  if (/403|permission[ _-]?denied/i.test(raw)) return "The key is valid but has no access. Check its permissions and that the account has billing set up.";
  if (/429|quota|rate[ _-]?limit/i.test(raw)) return "The key works, but the account has no quota left at the moment.";
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(raw)) return "Saved, but the check couldn't reach the service. Try a session to see if it works.";
  return raw.slice(0, 200);
}

/** Tries the key straight away, so a typo is reported while the student is still looking at it. */
async function testKeys(changed: Partial<Record<KeyProvider, string>>): Promise<Partial<Record<KeyProvider, string | null>>> {
  const tests: Partial<Record<KeyProvider, string | null>> = {};
  await Promise.all(
    KEY_PROVIDERS.filter((p) => changed[p]).map(async (provider) => {
      try {
        if (provider === "claude") await listClaudeModels();
        else await listGeminiModels();
        tests[provider] = null; // works
      } catch (err) {
        tests[provider] = keyProblem(err);
      }
    }),
  );
  return tests;
}

/** Accepts a partial update and merges it into the saved settings. */
export async function PUT(req: Request) {
  try {
    const input = (await req.json().catch(() => ({}))) as Partial<Record<keyof AppSettings, Record<string, unknown>>> & { keys?: unknown };
    const changedKeys = await saveKeys(input.keys);
    const settings = await withLock(async () => {
      const current = await readSettings();
      const models = { ...current.models };
      for (const job of BRAIN_JOBS) models[job] = choice(input.models?.[job], current.models[job]);
      const v = input.voice ?? {};
      const t = input.transcription ?? {};
      const c = input.conversation ?? {};
      const a = input.avatar ?? {};
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
          provider: VOICE_PROVIDERS.includes(v.provider as VoiceProvider) ? (v.provider as VoiceProvider) : current.voice.provider,
          geminiModel: text(v.geminiModel, current.voice.geminiModel),
          geminiVoice: GEMINI_VOICES.some((g) => g.name === v.geminiVoice) ? (v.geminiVoice as string) : current.voice.geminiVoice,
          // Not checked against the server's list: it may be stopped while its voice stays chosen.
          xttsSpeaker: typeof v.xttsSpeaker === "string" ? v.xttsSpeaker.trim().slice(0, 120) : current.voice.xttsSpeaker,
          piperVoiceFr: typeof v.piperVoiceFr === "string" ? v.piperVoiceFr.trim().slice(0, 120) : current.voice.piperVoiceFr,
          piperVoiceEn: typeof v.piperVoiceEn === "string" ? v.piperVoiceEn.trim().slice(0, 120) : current.voice.piperVoiceEn,
          piperSpeedFr: speed(v.piperSpeedFr, current.voice.piperSpeedFr),
          piperSpeedEn: speed(v.piperSpeedEn, current.voice.piperSpeedEn),
          // Empty string is meaningful here: "choose automatically".
          browserVoiceEn: typeof v.browserVoiceEn === "string" ? v.browserVoiceEn.slice(0, 200) : current.voice.browserVoiceEn,
          browserVoiceFr: typeof v.browserVoiceFr === "string" ? v.browserVoiceFr.slice(0, 200) : current.voice.browserVoiceFr,
        },
        avatar: {
          mode: AVATAR_MODES.includes(a.mode as AvatarMode) ? (a.mode as AvatarMode) : current.avatar.mode,
          modelUrl: typeof a.modelUrl === "string" ? avatarUrl(a.modelUrl, current.avatar.modelUrl) : current.avatar.modelUrl,
          photo: typeof a.photo === "string" && /^[\w-]{1,60}$/.test(a.photo.trim()) ? a.photo.trim() : current.avatar.photo,
        },
        conversation: {
          handsFree: typeof c.handsFree === "boolean" ? c.handsFree : current.conversation.handsFree,
          endSilenceMs:
            typeof c.endSilenceMs === "number" && Number.isFinite(c.endSilenceMs)
              ? Math.round(Math.min(END_SILENCE_RANGE.max, Math.max(END_SILENCE_RANGE.min, c.endSilenceMs)))
              : current.conversation.endSilenceMs,
          sensitivity: MIC_SENSITIVITIES.includes(c.sensitivity as MicSensitivity) ? (c.sensitivity as MicSensitivity) : current.conversation.sensitivity,
          bargeIn: typeof c.bargeIn === "boolean" ? c.bargeIn : current.conversation.bargeIn,
          earlyTranscribe: typeof c.earlyTranscribe === "boolean" ? c.earlyTranscribe : current.conversation.earlyTranscribe,
          adaptivePause: typeof c.adaptivePause === "boolean" ? c.adaptivePause : current.conversation.adaptivePause,
          thinkingSound: typeof c.thinkingSound === "boolean" ? c.thinkingSound : current.conversation.thinkingSound,
        },
        updatedAt: new Date().toISOString(),
      };
      await writeSettings(next);
      return next;
    });
    return NextResponse.json({ settings, keys: await keyStatuses(), keyTests: await testKeys(changedKeys) });
  } catch (err) {
    return errorResponse(err);
  }
}
