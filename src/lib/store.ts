import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import { averageFluency } from "./fluency";
import { END_SILENCE_RANGE, SPEECH_SPEED_RANGE, TIMINGS_KEPT, type AppSettings, type Material, type KeyProvider, type KeyStatus, type LearnerProfile, type MistakeRecord, type ReviewCard, type Session, type SessionSummary, type TurnTiming, type UsageTotals } from "./types";

// Single-user app: plain JSON files in ./data are easy to inspect, back up, and edit by hand.

const file = (name: string) => path.join(config.dataDir, name);
const SESSION_ID = /^[0-9a-f-]{36}$/;

// Kept on globalThis because Next.js may load this module more than once in dev.
const lockHolder = globalThis as unknown as { __tutorStoreLock?: Promise<unknown> };

/** Serialises read-modify-write cycles so concurrent requests can't clobber each other's files. */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = lockHolder.__tutorStoreLock ?? Promise.resolve();
  const run = previous.then(fn, fn);
  lockHolder.__tutorStoreLock = run.catch(() => undefined);
  return run;
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Unreadable (e.g. zero-filled after a power loss). Set it aside rather than break the app.
    const backup = `${filePath}.corrupt-${Date.now()}`;
    await fs.rename(filePath, backup).catch(() => undefined);
    console.warn(`Couldn't read ${filePath}; moved it to ${backup} and started fresh.`);
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  // Flush to disk before swapping the file in, so sleep or power loss can't leave a half-written file.
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, filePath);
  } catch {
    // Windows can refuse the rename while another process (e.g. antivirus) has the file open.
    await fs.writeFile(filePath, body, "utf8");
    await fs.rm(tmp, { force: true });
  }
}

export function defaultProfile(): LearnerProfile {
  return {
    name: "",
    currentLevel: "A2",
    targetLevel: "B1",
    goals: "",
    correctionStyle: "gentle",
    focusAreas: [],
    levels: null,
    levelNotes: "",
    nextSessionPlan: "",
    updatedAt: new Date().toISOString(),
  };
}

export async function readProfile(): Promise<LearnerProfile> {
  return { ...defaultProfile(), ...(await readJson<Partial<LearnerProfile>>(file("profile.json"), {})) };
}
export const writeProfile = (profile: LearnerProfile) => writeJson(file("profile.json"), profile);

/** Defaults come from .env.local; choices made on the Settings page override them. */
export function defaultSettings(): AppSettings {
  return {
    models: {
      tutor: { provider: "claude", model: config.claude.tutorModel, effort: config.claude.tutorEffort },
      review: { provider: "claude", model: config.claude.reviewModel, effort: config.claude.reviewEffort },
      quiz: { provider: "gemini", model: config.gemini.textModel, effort: "low" },
      coach: { provider: "claude", model: config.claude.reviewModel, effort: "low" },
    },
    transcription: { engine: "gemini", model: config.gemini.transcribeModel, whisperTiming: true },
    memory: { enabled: true, model: config.ollama.embedModel },
    voice: {
      provider: "gemini",
      geminiModel: config.gemini.ttsModel,
      geminiVoice: config.gemini.ttsVoice,
      xttsSpeaker: config.xtts.speaker,
      piperVoiceFr: config.piper.voiceFr,
      piperVoiceEn: config.piper.voiceEn,
      piperSpeedFr: SPEECH_SPEED_RANGE.default,
      piperSpeedEn: SPEECH_SPEED_RANGE.default,
      browserVoiceEn: "",
      browserVoiceFr: "",
    },
    avatar: { mode: "3d", modelUrl: "", photo: "charlotte" },
    conversation: {
      handsFree: true,
      endSilenceMs: END_SILENCE_RANGE.default,
      sensitivity: "medium",
      bargeIn: true,
      earlyTranscribe: true,
      adaptivePause: true,
      thinkingSound: true,
    },
    updatedAt: "",
  };
}

export async function readSettings(): Promise<AppSettings> {
  const d = defaultSettings();
  const s = await readJson<Partial<AppSettings>>(file("settings.json"), {});
  return {
    models: {
      tutor: { ...d.models.tutor, ...s.models?.tutor },
      review: { ...d.models.review, ...s.models?.review },
      quiz: { ...d.models.quiz, ...s.models?.quiz },
      // The level coach arrived later, so an older settings file inherits the review model, which
      // is already a model this key can use. Chat doesn't need the review's high effort.
      coach: { ...d.models.coach, ...(s.models?.coach ?? (s.models?.review && { ...s.models.review, effort: "low" })) },
    },
    transcription: { ...d.transcription, ...s.transcription },
    memory: { ...d.memory, ...s.memory },
    voice: { ...d.voice, ...s.voice },
    avatar: { ...d.avatar, ...s.avatar },
    conversation: { ...d.conversation, ...s.conversation },
    updatedAt: s.updatedAt ?? d.updatedAt,
  };
}
export const writeSettings = (settings: AppSettings) => writeJson(file("settings.json"), settings);

// ---------------------------------------------------------------------------
// API keys saved from the Settings page
// ---------------------------------------------------------------------------

/**
 * Keys typed into the app, kept in data/secrets.json (git-ignored, this computer only). An
 * environment variable is still honoured, so an existing .env.local keeps working; a key saved
 * here wins, because that is the one the student just typed.
 */
export interface StoredSecrets {
  anthropicApiKey?: string;
  geminiApiKey?: string;
  /** Not a secret, but it belongs with the key it qualifies: see claudeWorkspaceId. */
  anthropicWorkspaceId?: string;
}

const secretsFile = () => file("secrets.json");
export const readSecrets = () => readJson<StoredSecrets>(secretsFile(), {});
export const writeSecrets = (secrets: StoredSecrets) => writeJson(secretsFile(), secrets);

const status = (saved: string | undefined, env: string | undefined): KeyStatus => {
  const key = saved?.trim() || env?.trim() || "";
  return { source: saved?.trim() ? "app" : env?.trim() ? "environment" : "none", hint: key ? key.slice(-4) : "" };
};

export async function keyStatuses(): Promise<Record<KeyProvider, KeyStatus>> {
  const saved = await readSecrets();
  return {
    claude: status(saved.anthropicApiKey, process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    gemini: status(saved.geminiApiKey, process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  };
}

export async function claudeKey(): Promise<string | undefined> {
  const saved = (await readSecrets()).anthropicApiKey?.trim();
  return saved || process.env.ANTHROPIC_API_KEY?.trim() || undefined;
}

/**
 * An Anthropic key made for a whole organisation isn't tied to a workspace, and every request
 * with one has to name the workspace itself. A key made inside a workspace carries it already,
 * and then this stays empty.
 */
export async function claudeWorkspaceId(): Promise<string | undefined> {
  const saved = (await readSecrets()).anthropicWorkspaceId?.trim();
  return saved || config.claude.workspaceId.trim() || undefined;
}

export async function geminiKey(): Promise<string | undefined> {
  const saved = (await readSecrets()).geminiApiKey?.trim();
  return saved || process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || undefined;
}

/** Token totals per local day, keyed by "provider|model|feature". */
export type UsageLog = Record<string, Record<string, UsageTotals>>;
export const readUsage = () => readJson<UsageLog>(file("usage.json"), {});
export const writeUsage = (usage: UsageLog) => writeJson(file("usage.json"), usage);

export const readMaterials = () => readJson<Material[]>(file("materials.json"), []);
export const writeMaterials = (materials: Material[]) => writeJson(file("materials.json"), materials);

export const readMistakes = () => readJson<MistakeRecord[]>(file("mistakes.json"), []);
export const writeMistakes = (mistakes: MistakeRecord[]) => writeJson(file("mistakes.json"), mistakes);

/** Ollama embedding vectors, keyed by mistake id. Kept separate so mistake data stays readable. */
export const readEmbeddings = () => readJson<Record<string, number[]>>(file("mistake-embeddings.json"), {});
export const writeEmbeddings = (vectors: Record<string, number[]>) => writeJson(file("mistake-embeddings.json"), vectors);

/** Stage-by-stage timings of spoken turns, newest last. See TurnTiming for what the stages mean. */
export const readTimings = () => readJson<TurnTiming[]>(file("timings.json"), []);

/** Appends one turn and drops the oldest, so the file can't grow without bound. */
export async function recordTiming(timing: TurnTiming): Promise<void> {
  await withLock(async () => {
    const all = await readTimings();
    await writeJson(file("timings.json"), [...all, timing].slice(-TIMINGS_KEPT));
  });
}

export const readCards = () => readJson<ReviewCard[]>(file("cards.json"), []);
export const writeCards = (cards: ReviewCard[]) => writeJson(file("cards.json"), cards);

function sessionFile(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error("Invalid session id");
  return file(path.join("sessions", `${id}.json`));
}

export const readSession = (id: string) => readJson<Session | null>(sessionFile(id), null);
export const writeSession = (session: Session) => writeJson(sessionFile(session.id), session);

/** All sessions, newest first. */
export async function readAllSessions(): Promise<Session[]> {
  let names: string[];
  try {
    names = await fs.readdir(file("sessions"));
  } catch {
    return [];
  }
  const sessions = await Promise.all(
    names.filter((n) => n.endsWith(".json")).map((n) => readJson<Session | null>(file(path.join("sessions", n)), null)),
  );
  return sessions.filter((s): s is Session => s !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function summarizeSession({ turns, ...rest }: Session): SessionSummary {
  return {
    ...rest,
    turnCount: turns.filter((t) => t.role === "student").length,
    studentWords: turns
      .filter((t) => t.role === "student")
      .reduce((n, t) => n + (t.text ?? "").trim().split(/\s+/).filter(Boolean).length, 0),
    correctionCount: turns.reduce((n, t) => n + (t.reply?.corrections.length ?? 0), 0),
    fluency: averageFluency(turns.flatMap((t) => (t.fluency ? [t.fluency] : []))),
  };
}
