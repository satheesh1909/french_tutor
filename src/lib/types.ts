// Shared between server routes and client components — no Node imports here.

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

export type SessionSummary = Omit<Session, "turns"> & { turnCount: number; correctionCount: number };

export type VoiceProvider = "gemini" | "browser";

export interface LearnerProfile {
  name: string;
  currentLevel: CefrLevel;
  targetLevel: CefrLevel;
  goals: string;
  correctionStyle: "gentle" | "explicit";
  voice: VoiceProvider;
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
