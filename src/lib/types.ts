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
  /** Id the browser gave this answer, so an interrupted answer can be replaced by the combined one. */
  clientTurnId?: string;
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

export type ScenarioCategory = "everyday" | "work";

export const SCENARIO_CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  everyday: "Everyday life",
  work: "At the office",
};

/** One turn of the Progress-page conversation about the student's level. */
export interface CoachTurn {
  role: "student" | "coach";
  text: string;
}

export interface CoachAnswer {
  answer: string;
  /** Set when the answer points at something worth drilling, e.g. "passé composé vs imparfait". */
  quizTopic: string | null;
}

export interface RoleplayScenario {
  id: string;
  title: string;
  level: CefrLevel;
  category: ScenarioCategory;
  brief: string;
}

/** Picked in the session picker to role-play a situation the student describes in their own words. */
export const CUSTOM_SCENARIO_ID = "custom";

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

export const BRAIN_JOBS = ["tutor", "review", "quiz", "coach"] as const;
export type BrainJob = (typeof BRAIN_JOBS)[number];

export const JOB_LABELS: Record<BrainJob, { title: string; description: string }> = {
  tutor: { title: "Tutor conversation", description: "Replies, corrections and explanations during sessions" },
  review: { title: "Session review", description: "Level estimates and focus areas when a session ends" },
  quiz: { title: "Quiz writer", description: "Written quizzes on the Practice page" },
  coach: { title: "Level coach", description: "Answers questions about your level and progress on the Progress page" },
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

export const MIC_SENSITIVITIES = ["low", "medium", "high"] as const;
export type MicSensitivity = (typeof MIC_SENSITIVITIES)[number];

export interface ConversationSettings {
  /** Keep the microphone open and send each answer automatically after a pause. */
  handsFree: boolean;
  /** How long a silence ends your turn. */
  endSilenceMs: number;
  sensitivity: MicSensitivity;
  /** Starting to speak while the tutor talks stops her. */
  bargeIn: boolean;
}

export const END_SILENCE_RANGE = { min: 800, max: 4000, default: 2000 };

export const AVATAR_MODES = ["photo", "3d", "portrait"] as const;
export type AvatarMode = (typeof AVATAR_MODES)[number];

export interface AvatarSettings {
  mode: AvatarMode;
  /** Optional .glb head (e.g. a Ready Player Me avatar). Empty means the built-in sculpted head. */
  modelUrl: string;
  /** Which photo in avatar_server/faces she wears in "photo" mode. */
  photo: string;
}

export const AVATAR_MODE_LABELS: Record<AvatarMode, { title: string; description: string }> = {
  photo: { title: "Photo", description: "A real photo of her, lip-synced to her voice on your GPU" },
  "3d": { title: "3D head", description: "Sculpted in the browser: jaw, blinks and glances, no setup" },
  portrait: { title: "Simple", description: "A quiet circle, for when you want no motion at all" },
};

export interface AppSettings {
  models: Record<BrainJob, ModelChoice>;
  /** `model` is the Gemini model; Whisper's model is chosen when its local server starts. */
  transcription: { engine: TranscriptionEngine; model: string; whisperTiming: boolean };
  memory: { enabled: boolean; model: string };
  voice: VoiceSettings;
  avatar: AvatarSettings;
  conversation: ConversationSettings;
  updatedAt: string;
}

/** Where an API key is coming from, for the Settings page. Never carries the key itself. */
export interface KeyStatus {
  source: "app" | "environment" | "none";
  /** Last four characters, so the student can tell which key is saved. */
  hint: string;
}

export const KEY_PROVIDERS = ["claude", "gemini"] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

export const KEY_LABELS: Record<KeyProvider, { title: string; where: string; url: string }> = {
  claude: { title: "Claude (Anthropic)", where: "console.anthropic.com", url: "https://console.anthropic.com/settings/keys" },
  gemini: { title: "Gemini (Google)", where: "Google AI Studio", url: "https://aistudio.google.com/apikey" },
};

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

/**
 * Gemini's prebuilt voices. Google publishes the style word but not the pitch or the gender, so
 * `hz` is the median pitch we measured from a sample of each voice (see voiceRegister below).
 */
export interface GeminiVoice {
  name: string;
  style: string;
  /** Median pitch in hertz, measured from a spoken sample. */
  hz: number;
}

/** Voices split cleanly into two groups around 180 Hz, which is where male and female speech parts. */
export const VOICE_REGISTERS = {
  higher: { label: "Higher pitched", hint: "usually reads as female" },
  lower: { label: "Lower pitched", hint: "usually reads as male" },
} as const;

export type VoiceRegister = keyof typeof VOICE_REGISTERS;
export const voiceRegister = (hz: number): VoiceRegister => (hz >= 180 ? "higher" : "lower");

export const GEMINI_VOICES: GeminiVoice[] = [
  { name: "Achernar", style: "Soft", hz: 214 },
  { name: "Achird", style: "Friendly", hz: 148 },
  { name: "Algenib", style: "Gravelly", hz: 141 },
  { name: "Algieba", style: "Smooth", hz: 176 },
  { name: "Alnilam", style: "Firm", hz: 169 },
  { name: "Aoede", style: "Breezy", hz: 214 },
  { name: "Autonoe", style: "Bright", hz: 192 },
  { name: "Callirrhoe", style: "Easy-going", hz: 205 },
  { name: "Charon", style: "Informative", hz: 155 },
  { name: "Despina", style: "Smooth", hz: 205 },
  { name: "Enceladus", style: "Breathy", hz: 156 },
  { name: "Erinome", style: "Clear", hz: 224 },
  { name: "Fenrir", style: "Excitable", hz: 226 },
  { name: "Gacrux", style: "Mature", hz: 195 },
  { name: "Iapetus", style: "Clear", hz: 152 },
  { name: "Kore", style: "Firm", hz: 211 },
  { name: "Laomedeia", style: "Upbeat", hz: 192 },
  { name: "Leda", style: "Youthful", hz: 229 },
  { name: "Orus", style: "Firm", hz: 157 },
  { name: "Pulcherrima", style: "Forward", hz: 160 },
  { name: "Puck", style: "Upbeat", hz: 147 },
  { name: "Rasalgethi", style: "Informative", hz: 186 },
  { name: "Sadachbia", style: "Lively", hz: 168 },
  { name: "Sadaltager", style: "Knowledgeable", hz: 155 },
  { name: "Schedar", style: "Even", hz: 157 },
  { name: "Sulafat", style: "Warm", hz: 211 },
  { name: "Umbriel", style: "Easy-going", hz: 162 },
  { name: "Vindemiatrix", style: "Gentle", hz: 197 },
  { name: "Zephyr", style: "Bright", hz: 203 },
  { name: "Zubenelgenubi", style: "Casual", hz: 147 },
];

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export const USAGE_FEATURES = ["tutor", "review", "quiz", "coach", "transcription", "voice", "memory"] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

export const FEATURE_LABELS: Record<UsageFeature, string> = {
  tutor: "Tutor conversation",
  review: "Session review",
  quiz: "Quiz writer",
  coach: "Level coach",
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
  { id: "cafe", title: "Au café", level: "A2", category: "everyday", brief: "Order drinks and a snack at a Paris café, ask about the menu, pay the bill, and chat with the waiter." },
  { id: "directions", title: "Perdu en ville", level: "A2", category: "everyday", brief: "Ask a passer-by for directions to the métro and a pharmacy, and check you've understood." },
  { id: "weekend", title: "Le week-end dernier", level: "A2", category: "everyday", brief: "A friend asks what you did last weekend; tell the story and ask about theirs." },
  { id: "doctor", title: "Chez le médecin", level: "B1", category: "everyday", brief: "Describe your symptoms to a doctor, explain since when and how it started, and understand the advice." },
  { id: "apartment", title: "Louer un appartement", level: "B1", category: "everyday", brief: "Phone an agency about a flat: ask about rent, charges, the neighbourhood, and arrange a viewing." },
  { id: "complaint", title: "Réclamation au magasin", level: "B1", category: "everyday", brief: "Return a faulty product and negotiate a refund or exchange with a reluctant shop assistant." },

  { id: "office-first-day", title: "Premier jour au bureau", level: "A2", category: "work", brief: "You are new. Introduce yourself to a colleague: your name, your job, where you worked before. Ask who does what in the team, where the kitchen and the meeting rooms are, and what time people arrive." },
  { id: "office-coffee", title: "Pause café", level: "A2", category: "work", brief: "Small talk with a colleague at the coffee machine: the weekend, the weather, how busy you both are, the canteen, plans for the evening. Keep it light and friendly, and ask questions back." },
  { id: "office-standup", title: "Réunion d'équipe", level: "B1", category: "work", brief: "A short stand-up meeting. You are the colleague running it: ask what the student did yesterday, what they will do today, and whether anything is blocking them. Ask for detail when an answer is vague, and check dates and numbers." },
  { id: "office-one-to-one", title: "Point avec le manager", level: "B1", category: "work", brief: "You are the student's manager in a one-to-one. Ask how the work is going and how they feel about their workload, then let them ask for something: a training course, holiday, help on a task, or a change of priorities. Push back gently so they have to justify it." },
  { id: "office-deadline", title: "Repousser une échéance", level: "B1", category: "work", brief: "You are a stakeholder waiting for something that is late. The student has to explain what went wrong, what has been done already, and propose a new date. Be disappointed but reasonable, and ask what will prevent it happening again." },
  { id: "office-client-call", title: "Appel client", level: "B1", category: "work", brief: "A phone call with a client. You are the client: ask for a status update, question the cost, mention a problem you had, and ask what happens next. The student has to reassure you and agree the next steps." },
  { id: "office-explain-process", title: "Expliquer un processus", level: "B1", category: "work", brief: "You are a new joiner and the student explains a process or tool to you step by step. Ask 'and then?', ask what happens if something fails, and ask them to repeat anything that wasn't clear. Make them use sequencing words and the imperative." },
  { id: "office-presentation", title: "Présenter un projet", level: "B2", category: "work", brief: "The student presents a project to management. You are a sceptical director: ask about the budget, the risks, the timeline and the benefits, and interrupt with hard questions. Make them structure their answer and defend their figures." },
  { id: "office-disagreement", title: "Désaccord avec un collègue", level: "B2", category: "work", brief: "You disagree with the student's approach and say so, politely but firmly. They have to disagree back diplomatically, concede what is fair, and find a compromise. Push them towards softened forms and the subjonctif after expressions of doubt or will." },
  { id: "office-appraisal", title: "Entretien annuel", level: "B2", category: "work", brief: "You are the manager running an annual appraisal. Ask what went well, what went badly, and what they want next year. Give one piece of critical feedback and let them respond. If they ask for a raise or a promotion, ask them to make the case." },
  { id: "office-negotiate", title: "Négocier avec un prestataire", level: "B2", category: "work", brief: "You are a supplier defending your quote. The student negotiates the price, the scope and the delivery date. Hold your ground, offer small concessions, and make them argue with conditionals and hypotheses." },
  { id: "interview", title: "Entretien d'embauche", level: "B2", category: "work", brief: "A job interview: present your experience and strengths, and handle tricky questions." },
  { id: "debate", title: "Débat : le télétravail", level: "B2", category: "work", brief: "Argue for or against remote work with a colleague who disagrees; defend and nuance your opinion." },
];
