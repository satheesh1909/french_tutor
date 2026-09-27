import { z } from "zod";
import { UserFacingError } from "./http";
import { generateStructured } from "./llm";
import { coachInput, COACH_SYSTEM_PROMPT, quizPrompt, REVIEW_SYSTEM_PROMPT, reviewInput, tutorSystemPrompt } from "./prompts";
import { readSettings } from "./store";
import type { ChatMessage } from "./structured";
import {
  CEFR_LEVELS,
  ERROR_CATEGORIES,
  PROVIDER_LABELS,
  type CoachAnswer,
  type CoachTurn,
  type LearnerProfile,
  type MistakeRecord,
  type QuizQuestion,
  type ReviewCard,
  type Session,
  type SessionReview,
  type TutorReply,
} from "./types";

// The tutor's three thinking jobs. Which model does each one is chosen on the Settings page.

// Corrections come before speech so the model notices the mistakes before it phrases its reply.
const TutorReplySchema = z.object({
  corrections: z.array(
    z.object({
      original: z.string(),
      corrected: z.string(),
      category: z.enum(ERROR_CATEGORIES),
      explanation: z.string(),
      severity: z.enum(["minor", "major"]),
    }),
  ),
  speech: z.array(z.object({ lang: z.enum(["fr", "en"]), text: z.string() })),
  vocabulary: z.array(z.object({ french: z.string(), english: z.string(), example: z.string() })),
});

const Level = z.enum(CEFR_LEVELS);
/**
 * The review's ruling on each correction the tutor drafted during the session. Nothing reaches
 * the mistake history until it has a verdict here: see src/app/api/session/end/route.ts.
 */
const VerifiedCorrectionSchema = z.object({
  original: z.string(),
  corrected: z.string(),
  category: z.enum(ERROR_CATEGORIES),
  severity: z.enum(["major", "minor"]),
  explanation: z.string(),
  verdict: z.enum(["confirmed", "amended", "wrong"]),
});

const ReviewSchema = z.object({
  summary: z.string(),
  strengths: z.array(z.string()),
  focusAreas: z.array(z.string()),
  levelNotes: z.string(),
  fluencyNote: z.string(),
  levels: z.object({ overall: Level, speaking: Level, grammar: Level, vocabulary: Level }),
  nextSessionPlan: z.string(),
  encouragement: z.string(),
  verifiedCorrections: z.array(VerifiedCorrectionSchema).default([]),
});

const CoachSchema = z.object({
  answer: z.string(),
  quizTopic: z.string().nullable(),
});

const QuizSchema = z.object({
  questions: z.array(
    z.object({
      type: z.enum(["multiple_choice", "fill_blank", "translate"]),
      question: z.string(),
      options: z.array(z.string()),
      answer: z.string(),
      acceptedAnswers: z.array(z.string()),
      explanation: z.string(),
      category: z.enum(ERROR_CATEGORIES),
    }),
  ),
});

/** Replays the stored session, with each turn exactly as first sent (context blocks included). */
function toMessages(session: Session): ChatMessage[] {
  return session.turns.map((turn): ChatMessage => {
    if (turn.role === "tutor") {
      const reply: TutorReply = turn.reply ?? { corrections: [], speech: [{ lang: "en", text: turn.text }], vocabulary: [] };
      return { role: "assistant", parts: [JSON.stringify(reply)] };
    }
    return { role: "user", parts: turn.context ? [turn.context, turn.text] : [turn.text] };
  });
}

export async function generateTutorReply(session: Session, signal?: AbortSignal): Promise<TutorReply> {
  const { models } = await readSettings();
  const reply = await generateStructured(models.tutor, {
    feature: "tutor",
    system: tutorSystemPrompt(),
    messages: toMessages(session),
    schema: TutorReplySchema,
    signal,
  });
  if (!reply.speech.some((s) => s.text.trim())) {
    throw new UserFacingError(
      `${PROVIDER_LABELS[models.tutor.provider]} (${models.tutor.model}) gave an empty reply. Try again, or choose a stronger tutor model in Settings.`,
      502,
    );
  }
  return reply;
}

export async function reviewSession(profile: LearnerProfile, session: Session): Promise<SessionReview> {
  const { models } = await readSettings();
  return generateStructured(models.review, {
    feature: "review",
    system: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", parts: [reviewInput(profile, session)] }],
    schema: ReviewSchema,
  });
}

export async function generateQuiz(
  profile: LearnerProfile,
  mistakes: MistakeRecord[],
  vocab: ReviewCard[],
  count: number,
  topic?: string | null,
): Promise<QuizQuestion[]> {
  const { models } = await readSettings();
  const { questions } = await generateStructured(models.quiz, {
    feature: "quiz",
    system: "You are an expert French teacher who writes accurate practice questions. Reply with the requested JSON only.",
    messages: [{ role: "user", parts: [quizPrompt(profile, mistakes, vocab, count, topic)] }],
    schema: QuizSchema,
  });
  const usable = questions
    .filter((q) => q.question && q.answer)
    .filter((q) => q.type !== "multiple_choice" || q.options.includes(q.answer))
    .map((q) => ({
      ...q,
      id: crypto.randomUUID(),
      options: q.type === "multiple_choice" ? q.options : [],
      acceptedAnswers: [...new Set([q.answer, ...q.acceptedAnswers])],
    }));
  if (usable.length === 0) {
    throw new UserFacingError(
      `${PROVIDER_LABELS[models.quiz.provider]} (${models.quiz.model}) didn't write any usable questions. Try again, or choose a stronger quiz model in Settings.`,
      502,
    );
  }
  return usable;
}

/**
 * Answers the student's questions about their own level, on the Progress page. Everything the
 * coach knows is in the evidence block: profile, session reviews, mistakes and speaking speed.
 */
export async function answerCoachQuestion(
  profile: LearnerProfile,
  sessions: Session[],
  mistakes: MistakeRecord[],
  cards: ReviewCard[],
  history: CoachTurn[],
): Promise<CoachAnswer> {
  const { models } = await readSettings();
  const evidence = coachInput(profile, sessions, mistakes, cards);
  const messages: ChatMessage[] = history.map((turn, i) =>
    turn.role === "coach" ? { role: "assistant", parts: [turn.text] } : { role: "user", parts: i === 0 ? [evidence, turn.text] : [turn.text] },
  );
  // The evidence goes with the first question, so a long conversation keeps one copy of it.
  if (messages.length > 0 && history[0].role !== "student") messages.unshift({ role: "user", parts: [evidence] });

  const reply = await generateStructured(models.coach, { feature: "coach", system: COACH_SYSTEM_PROMPT, messages, schema: CoachSchema });
  if (!reply.answer.trim()) {
    throw new UserFacingError(
      `${PROVIDER_LABELS[models.coach.provider]} (${models.coach.model}) gave an empty answer. Try again, or choose a stronger model for the level coach in Settings.`,
      502,
    );
  }
  const quizTopic = reply.quizTopic?.trim();
  return { answer: reply.answer.trim(), quizTopic: quizTopic ? quizTopic.slice(0, 120) : null };
}
