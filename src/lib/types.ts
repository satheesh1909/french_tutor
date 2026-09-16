// Shared between server routes and client components — no Node imports here.

import type { FluencyAverage, FluencyStats } from "./fluency";

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const TUTOR_MODES = ["conversation", "roleplay", "lesson", "oral_quiz", "placement"] as const;
export type TutorMode = (typeof TUTOR_MODES)[number];

export const MODE_LABELS: Record<TutorMode, { title: string; description: string }> = {
  conversation: { title: "Conversation", description: "Chat about your life and interests" },
  roleplay: { title: "Role-play", description: "Real-life situations in French" },
  lesson: { title: "Lesson", description: "Learn a grammar point step by step" },
  oral_quiz: { title: "Oral quiz", description: "Quick-fire questions on your weak spots" },
  placement: { title: "Level check", description: "Assessment interview to find your level" },
};

export const ERROR_CATEGORIES = [
  "articles_contractions",
  "gender",
  "agreement",
  "conjugation",
  "auxiliary",
  "tense_choice",
  "si_clauses_conditional",
  "subjunctive",
  "pronouns",
  "prepositions",
  "negation",
  "word_order",
  "elision_euphony",
  "vocabulary_word_choice",
  "anglicism",
  "register",
  "spelling_accents",
  "other",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  articles_contractions: "Articles & contractions (au, du, de la)",
  gender: "Noun gender",
  agreement: "Agreement (adjectives, past participles)",
  conjugation: "Verb conjugation",
  auxiliary: "Auxiliary: être vs avoir",
  tense_choice: "Tense choice (passé composé / imparfait / futur)",
  si_clauses_conditional: "Si-clauses & conditional",
  subjunctive: "Subjunctive",
  pronouns: "Pronouns (y, en, le/lui, qui/que)",
  prepositions: "Prepositions",
  negation: "Negation",
  word_order: "Word order",
  elision_euphony: "Elision & euphony (qu'il, mon amie)",
  vocabulary_word_choice: "Vocabulary & word choice",
  anglicism: "Anglicisms",
  register: "Register (tu/vous, formality)",
  spelling_accents: "Spelling & accents",
  other: "Other",
};

export type Lang = "fr" | "en";

export interface SpeechSegment {
  lang: Lang;
  text: string;
}

export interface Correction {
  original: string;
  corrected: string;
  category: ErrorCategory;
  explanation: string;
  severity: "minor" | "major";
}

export interface VocabItem {
  french: string;
  english: string;
  example: string;
}

export interface TutorReply {
  speech: SpeechSegment[];
  corrections: Correction[];
  vocabulary: VocabItem[];
}

export type InputMethod = "voice" | "text";

export interface ChatTurn {
  id: string;
  /** "note" turns are stage directions sent to the tutor (e.g. "session started") and hidden in the UI. */
  role: "student" | "tutor" | "note";
  text: string;
  at: string;
  inputMethod?: InputMethod;
  /** Speaking speed for spoken turns. */
  fluency?: FluencyStats;
  /** Learner context sent alongside this turn. Stored so the replayed history stays byte-identical for prompt caching. */
  context?: string;
  reply?: TutorReply;
}

export const speechText = (reply: TutorReply) => reply.speech.map((s) => s.text).join(" ");

export interface LevelEstimates {
  overall: CefrLevel;
  speaking: CefrLevel;
  grammar: CefrLevel;
  vocabulary: CefrLevel;
}

export interface SessionReview {
  summary: string;
  strengths: string[];
  focusAreas: string[];
  levels: LevelEstimates;
  levelNotes: string;
  nextSessionPlan: string;
  encouragement: string;
  /** Comment on speaking pace and pauses; absent in reviews made before speed was measured. */
  fluencyNote?: string;
}

export interface Session {
  id: string;
  mode: TutorMode;
  scenarioId: string | null;
  topic: string | null;
  startedAt: string;
  endedAt: string | null;
  turns: ChatTurn[];
  review: SessionReview | null;
}

export type SessionSummary = Omit<Session, "turns"> & { turnCount: number; correctionCount: number; fluency: FluencyAverage | null };

export type VoiceProvider = "gemini" | "browser";

export interface LearnerProfile {
  name: string;
  currentLevel: CefrLevel;
  targetLevel: CefrLevel;
  goals: string;
  correctionStyle: "gentle" | "explicit";
  focusAreas: string[];
  levels: LevelEstimates | null;
  levelNotes: string;
  nextSessionPlan: string;
  updatedAt: string;
}

export interface MistakeRecord {
  id: string;
  category: ErrorCategory;
  original: string;
  corrected: string;
  explanation: string;
  severity: "minor" | "major";
  count: number;
  firstSeen: string;
  lastSeen: string;
  sessionIds: string[];
}

export interface ReviewCard {
  id: string;
  kind: "correction" | "vocab";
  mistakeId: string | null;
  /** correction: the wrong sentence to fix. vocab: the English meaning. */
  prompt: string;
  /** correction: the corrected form. vocab: the French expression. */
  answer: string;
  note: string;
  category: ErrorCategory | null;
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  due: string;
  createdAt: string;
  lastReviewed: string | null;
}

export interface QuizQuestion {
  id: string;
  type: "multiple_choice" | "fill_blank" | "translate";
  question: string;
  options: string[];
  answer: string;
  acceptedAnswers: string[];
  explanation: string;
  category: ErrorCategory;
}

export interface RoleplayScenario {
  id: string;
  title: string;
  level: CefrLevel;
  brief: string;
}

// ---------------------------------------------------------------------------
// Settings: which AI does which job, and how the tutor sounds
// ---------------------------------------------------------------------------

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The requested effort if supported, otherwise the nearest supported level (lower on a tie); undefined if none. */
export function nearestEffort(requested: Effort, supported: readonly Effort[]): Effort | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(requested)) return requested;
  const rank = (e: Effort) => EFFORTS.indexOf(e);
  return [...supported].sort((a, b) => Math.abs(rank(a) - rank(requested)) - Math.abs(rank(b) - rank(requested)) || rank(a) - rank(b))[0];
}

export const PROVIDERS = ["claude", "gemini", "ollama"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude: "Claude",
  gemini: "Gemini",
  ollama: "Local (Ollama)",
};

/** Effort only applies to Claude models. */
export interface ModelChoice {
  provider: Provider;
  model: string;
  effort: Effort;
}

export const BRAIN_JOBS = ["tutor", "review", "quiz"] as const;
export type BrainJob = (typeof BRAIN_JOBS)[number];

export const JOB_LABELS: Record<BrainJob, { title: string; description: string }> = {
  tutor: { title: "Tutor conversation", description: "Replies, corrections and explanations during sessions" },
  review: { title: "Session review", description: "Level estimates and focus areas when a session ends" },
  quiz: { title: "Quiz writer", description: "Written quizzes on the Practice page" },
};

export interface VoiceSettings {
  provider: VoiceProvider;
  geminiModel: string;
  geminiVoice: string;
  /** Browser voice names; empty means pick automatically. */
  browserVoiceEn: string;
  browserVoiceFr: string;
}

export type TranscriptionEngine = "gemini" | "whisper";

export interface AppSettings {
  models: Record<BrainJob, ModelChoice>;
  /** `model` is the Gemini model; Whisper's model is chosen when its local server starts. */
  transcription: { engine: TranscriptionEngine; model: string; whisperTiming: boolean };
  memory: { enabled: boolean; model: string };
  voice: VoiceSettings;
  updatedAt: string;
}

export interface OllamaModelInfo {
  name: string;
  parameterSize: string;
  sizeGb: number;
  capabilities: string[];
}

export interface SettingsOptions {
  claude: { connected: boolean; models: { id: string; label: string; efforts: Effort[]; structuredOutputs: boolean }[] };
  gemini: { connected: boolean; text: string[]; tts: string[]; transcribe: string[] };
  ollama: { online: boolean; chat: OllamaModelInfo[]; embedding: OllamaModelInfo[] };
  whisper: { online: boolean; model: string | null; device: string | null };
}

// Gemini's prebuilt TTS voices and their style descriptions.
export const GEMINI_VOICES: { name: string; style: string }[] = [
  { name: "Achernar", style: "Soft" },
  { name: "Achird", style: "Friendly" },
  { name: "Algenib", style: "Gravelly" },
  { name: "Algieba", style: "Smooth" },
  { name: "Alnilam", style: "Firm" },
  { name: "Aoede", style: "Breezy" },
  { name: "Autonoe", style: "Bright" },
  { name: "Callirrhoe", style: "Easy-going" },
  { name: "Charon", style: "Informative" },
  { name: "Despina", style: "Smooth" },
  { name: "Enceladus", style: "Breathy" },
  { name: "Erinome", style: "Clear" },
  { name: "Fenrir", style: "Excitable" },
  { name: "Gacrux", style: "Mature" },
  { name: "Iapetus", style: "Clear" },
  { name: "Kore", style: "Firm" },
  { name: "Laomedeia", style: "Upbeat" },
  { name: "Leda", style: "Youthful" },
  { name: "Orus", style: "Firm" },
  { name: "Pulcherrima", style: "Forward" },
  { name: "Puck", style: "Upbeat" },
  { name: "Rasalgethi", style: "Informative" },
  { name: "Sadachbia", style: "Lively" },
  { name: "Sadaltager", style: "Knowledgeable" },
  { name: "Schedar", style: "Even" },
  { name: "Sulafat", style: "Warm" },
  { name: "Umbriel", style: "Easy-going" },
  { name: "Vindemiatrix", style: "Gentle" },
  { name: "Zephyr", style: "Bright" },
  { name: "Zubenelgenubi", style: "Casual" },
];

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export const USAGE_FEATURES = ["tutor", "review", "quiz", "transcription", "voice", "memory"] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

export const FEATURE_LABELS: Record<UsageFeature, string> = {
  tutor: "Tutor conversation",
  review: "Session review",
  quiz: "Quiz writer",
  transcription: "Transcription",
  voice: "Voice",
  memory: "Mistake memory",
};

export interface UsageTotals {
  input: number;
  output: number;
  /** Input tokens served from cache (billed at a lower rate). Included in `input`. */
  cached: number;
  calls: number;
}

/** Usage is also tracked for the local Whisper server, which isn't a selectable "brain". */
export const USAGE_PROVIDERS = ["claude", "gemini", "ollama", "whisper"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  claude: "Claude",
  gemini: "Gemini",
  ollama: "Local (Ollama)",
  whisper: "Local (Whisper)",
};

export interface UsageRow extends UsageTotals {
  provider: UsageProvider;
  model: string;
  feature: UsageFeature;
}

export interface UsageReport {
  today: string;
  month: string;
  todayRows: UsageRow[];
  monthRows: UsageRow[];
  daily: { day: string; totals: Record<UsageProvider, UsageTotals> }[];
}

export const ROLEPLAY_SCENARIOS: RoleplayScenario[] = [
  { id: "cafe", title: "Au café", level: "A2", brief: "Order drinks and a snack at a Paris café, ask about the menu, pay the bill, and chat with the waiter." },
  { id: "directions", title: "Perdu en ville", level: "A2", brief: "Ask a passer-by for directions to the métro and a pharmacy, and check you've understood." },
  { id: "weekend", title: "Le week-end dernier", level: "A2", brief: "A friend asks what you did last weekend; tell the story and ask about theirs." },
  { id: "doctor", title: "Chez le médecin", level: "B1", brief: "Describe your symptoms to a doctor, explain since when and how it started, and understand the advice." },
  { id: "apartment", title: "Louer un appartement", level: "B1", brief: "Phone an agency about a flat: ask about rent, charges, the neighbourhood, and arrange a viewing." },
  { id: "complaint", title: "Réclamation au magasin", level: "B1", brief: "Return a faulty product and negotiate a refund or exchange with a reluctant shop assistant." },
  { id: "interview", title: "Entretien d'embauche", level: "B2", brief: "A job interview: present your experience and strengths, and handle tricky questions." },
  { id: "debate", title: "Débat : le télétravail", level: "B2", brief: "Argue for or against remote work with a colleague who disagrees; defend and nuance your opinion." },
];
