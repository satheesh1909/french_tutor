import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { hasClaudeCredentials } from "@/lib/providers/claude";
import { hasGeminiKey } from "@/lib/providers/gemini";
import { ollamaStatus } from "@/lib/providers/ollama";
import { avatarStatus } from "@/lib/providers/avatar";
import { whisperStatus } from "@/lib/providers/whisper";
import { piperStatus } from "@/lib/providers/piper";
import { xttsStatus } from "@/lib/providers/xtts";
import { readSettings } from "@/lib/store";
import { BRAIN_JOBS, type LocalVoiceStatus, type VoiceProvider } from "@/lib/types";

/**
 * Whichever local voice server the chosen voice needs, reduced to the part the tutor page cares
 * about: the page only needs to know it isn't ready and why, not which engine it is.
 */
async function localVoiceStatus(provider: VoiceProvider): Promise<LocalVoiceStatus | null> {
  if (provider !== "xtts" && provider !== "piper") return null;
  const { online, starting, problem } = await (provider === "xtts" ? xttsStatus() : piperStatus());
  return { online, starting, problem };
}

/** Which services are ready and which ones the current settings rely on, so the UI can explain what's missing. */
export async function GET() {
  const settings = await readSettings();
  const brains = BRAIN_JOBS.map((job) => settings.models[job].provider);
  const [ollama, whisper, avatarServer, voiceServer, claude, gemini] = await Promise.all([
    ollamaStatus(),
    whisperStatus(),
    settings.avatar.mode === "photo" ? avatarStatus() : Promise.resolve(null),
    localVoiceStatus(settings.voice.provider),
    hasClaudeCredentials(),
    hasGeminiKey(),
  ]);
  const engine = settings.transcription.engine;
  return NextResponse.json({
    claude,
    gemini,
    ollama,
    whisper,
    transcription: { engine, ready: engine === "whisper" ? whisper.online : gemini },
    uses: {
      claude: brains.includes("claude"),
      gemini: brains.includes("gemini") || settings.voice.provider === "gemini" || engine === "gemini",
      ollama: brains.includes("ollama"),
    },
    tutor: settings.models.tutor,
    voice: settings.voice,
    voiceServer,
    avatar: settings.avatar,
    avatarServer,
    conversation: settings.conversation,
    tutorName: config.tutorName,
  });
}
