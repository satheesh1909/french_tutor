import path from "node:path";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function effort(value: string | undefined, fallback: Effort): Effort {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : fallback;
}

export const config = {
  tutorName: process.env.TUTOR_NAME || "Charlotte",
  claude: {
    /** Only needed for an organisation key that isn't tied to one workspace. */
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || "",
    tutorModel: process.env.CLAUDE_TUTOR_MODEL || "claude-opus-5",
    tutorEffort: effort(process.env.CLAUDE_TUTOR_EFFORT, "low"),
    reviewModel: process.env.CLAUDE_REVIEW_MODEL || "claude-opus-5",
    reviewEffort: effort(process.env.CLAUDE_REVIEW_EFFORT, "high"),
  },
  gemini: {
    transcribeModel: process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-transcribe",
    ttsModel: process.env.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
    ttsVoice: process.env.GEMINI_TTS_VOICE || "Erinome",
    textModel: process.env.GEMINI_TEXT_MODEL || "gemini-3.8-flash",
  },
  ollama: {
    url: process.env.OLLAMA_URL || "http://localhost:11434",
    embedModel: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
  },
  whisper: {
    url: process.env.WHISPER_URL || "http://127.0.0.1:8765",
  },
  xtts: {
    url: process.env.XTTS_URL || "http://127.0.0.1:8767",
    speaker: process.env.XTTS_SPEAKER || "",
  },
  piper: {
    url: process.env.PIPER_URL || "http://127.0.0.1:8768",
    voiceFr: process.env.PIPER_VOICE_FR || "",
    voiceEn: process.env.PIPER_VOICE_EN || "",
  },
  avatar: {
    url: process.env.AVATAR_URL || "http://127.0.0.1:8766",
    facesDir: process.env.AVATAR_FACES_DIR || path.join(process.cwd(), "avatar_server", "faces"),
  },
  /**
   * How much the student has to actually say before a session may move their CEFR level. Two
   * turns and twenty-five words used to be enough to rewrite every estimate, which made the
   * level a measure of how often they pressed the button rather than of their French.
   */
  minWordsForLevel: Number(process.env.MIN_WORDS_FOR_LEVEL) || 150,
  minTurnsForLevel: Number(process.env.MIN_TURNS_FOR_LEVEL) || 4,
  /**
   * How many recent recordings to keep in data/recordings, with what was transcribed from each.
   * Set to 0 to keep none. They exist so a transcription that came back wrong can be replayed
   * through another model instead of guessed at.
   */
  keepRecordings: Number(process.env.KEEP_RECORDINGS ?? 20),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
};
