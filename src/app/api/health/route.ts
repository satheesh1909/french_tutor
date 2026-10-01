import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { hasClaudeCredentials } from "@/lib/providers/claude";
import { hasGeminiKey } from "@/lib/providers/gemini";
import { embedWarm, ollamaStatus } from "@/lib/providers/ollama";
import { avatarStatus } from "@/lib/providers/avatar";
import { whisperStatus } from "@/lib/providers/whisper";
import { piperStatus, piperWarm } from "@/lib/providers/piper";
import { xttsStatus } from "@/lib/providers/xtts";
import { readSettings } from "@/lib/store";
import { BRAIN_JOBS, type LocalVoiceStatus, type VoiceProvider, type VoiceSettings } from "@/lib/types";

/**
 * Whichever local voice server the chosen voice needs, reduced to the part the tutor page cares
 * about: the page only needs to know it isn't ready and why, not which engine it is.
 */
async function localVoiceStatus(provider: VoiceProvider, voice: VoiceSettings): Promise<LocalVoiceStatus | null> {
  if (provider !== "xtts" && provider !== "piper") return null;
  if (provider === "xtts") {
    const { online, starting, problem } = await xttsStatus();
    return { online, starting, problem };
  }
  const status = await piperStatus();
  if (status.online) warmPiper(status.loaded, voice);
  return { online: status.online, starting: status.starting, problem: status.problem };
}

/**
 * Loads the configured voices before they are needed. The page asks for health when it opens, which
 * is the right moment: it is the one time the student isn't waiting for an answer. Kept on
 * globalThis because Next.js may load this module more than once in dev.
 */
const warming = globalThis as unknown as { __piperWarming?: Promise<unknown>; __embedWarming?: Promise<unknown> };

/**
 * The same idea for the mistake memory: recalling past mistakes embeds what the student just said,
 * and that runs before the tutor is even asked, so a cold model is two seconds of silence.
 */
function warmEmbedder(online: boolean, enabled: boolean): void {
  if (!online || !enabled || warming.__embedWarming) return;
  warming.__embedWarming = embedWarm()
    .then((ok) => {
      if (!ok) console.warn("Couldn't warm the embedding model; the first recall will be slow.");
    })
    .finally(() => {
      warming.__embedWarming = undefined;
    });
}

function warmPiper(loaded: string[], voice: VoiceSettings): void {
  const wanted = [voice.piperVoiceFr, voice.piperVoiceEn].filter(Boolean);
  if (wanted.length === 0 || wanted.every((v) => loaded.includes(v))) return;
  if (warming.__piperWarming) return; // one at a time: the page may ask for health repeatedly
  warming.__piperWarming = piperWarm({ fr: voice.piperVoiceFr, en: voice.piperVoiceEn })
    .catch((err) => console.warn("Couldn't warm the voice server", err))
    .finally(() => {
      warming.__piperWarming = undefined;
    });
}

/** Which services are ready and which ones the current settings rely on, so the UI can explain what's missing. */
export async function GET() {
  const settings = await readSettings();
  const brains = BRAIN_JOBS.map((job) => settings.models[job].provider);
  const [ollama, whisper, avatarServer, voiceServer, claude, gemini] = await Promise.all([
    ollamaStatus(),
    whisperStatus(),
    // Both photo modes need this server: "photo" renders the video, and either one needs it to
    // list the portraits and to take a new one, because it is what finds the face in the picture.
    settings.avatar.mode === "photo" || settings.avatar.mode === "still" ? avatarStatus() : Promise.resolve(null),
    localVoiceStatus(settings.voice.provider, settings.voice),
    hasClaudeCredentials(),
    hasGeminiKey(),
  ]);
  warmEmbedder(ollama.online, settings.memory.enabled);
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
