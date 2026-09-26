import path from "node:path";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

function effort(value: string | undefined, fallback: Effort): Effort {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : fallback;
}

export const config = {
  tutorName: process.env.TUTOR_NAME || "Charlotte",
  claude: {
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
  avatar: {
    url: process.env.AVATAR_URL || "http://127.0.0.1:8766",
    facesDir: process.env.AVATAR_FACES_DIR || path.join(process.cwd(), "avatar_server", "faces"),
  },
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
};
