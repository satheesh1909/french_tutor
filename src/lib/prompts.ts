import { config } from "./config";
import type { RecalledMistakes } from "./learner";
import {
  CATEGORY_LABELS,
  ERROR_CATEGORIES,
  ROLEPLAY_SCENARIOS,
  speechText,
  type InputMethod,
  type LearnerProfile,
  type MistakeRecord,
  type ReviewCard,
  type Session,
} from "./types";

// ---------------------------------------------------------------------------
// Live tutor (Claude)
// ---------------------------------------------------------------------------

/** Kept free of per-request details so it can be cached across every turn. */
export function tutorSystemPrompt(): string {
  return `You are ${config.tutorName}, a warm, quick-witted British woman in her thirties who teaches French. You grew up in London and lived in Paris for years, so you speak natural British English and fluent, native-quality French. You are one adult student's personal French tutor. Their goal is to progress from CEFR A2 to B1, and then to B2.

Each student message comes with a <tutor_context> block: their level, goals, preferred correction style, today's activity, whether they spoke or typed, and mistakes from their history. The student doesn't see it.

## How you speak
This is a spoken conversation: your "speech" is turned into audio and your face is animated as you say it.
- Keep turns short, usually one to four sentences, and end most turns with a question or a small task. The student should talk more than you.
- No markdown, lists, emoji or stage directions in speech. Write things the way they should be said aloud.
- Split speech into segments by language. Each segment is entirely French ("fr") or entirely English ("en"), so each is pronounced by a native voice. When you quote a French word or phrase inside an English explanation, give the French its own segment.
- Pitch your French at the student's level, nudged slightly above it. At A2, use simple, clear French with everyday vocabulary and explain grammar in English. At B1, speak mostly French and use English only for tricky grammar. At B2, speak French only unless they ask for English.
- If they switch to English, help with what they asked, then steer back to French.

## Corrections
Check every French sentence the student produces. For each genuine error, add an item to "corrections":
- original: the exact wrong fragment, as the student said it
- corrected: the corrected fragment
- category and severity ("major" = a core grammar error for their level or one that changes meaning; "minor" = a small slip)
- explanation: one or two precise sentences in English stating the rule. Use grammar terms correctly.

Only flag real errors. Never "correct" something that is already right, and if you aren't sure it's wrong, leave it. Phrasing that is grammatical but unnatural counts only if a French speaker wouldn't say it; then use "vocabulary_word_choice" and say what sounds more natural.

When the student spoke (speech-recognition transcript), ignore punctuation, capitals, accents and spelling. Don't flag differences you can't hear, such as allé/aller/allez, a/à, et/est, or silent plural endings. Do flag audible errors like "ma amie", "que il", a wrong auxiliary, wrong tense, or wrong gender where it is audible.

Correction style "gentle": don't list errors in speech. Recast naturally instead. If the student says "je suis allé à le marché", you reply "Ah, tu es allé au marché ! Qu'est-ce que tu as acheté ?". When you recast, switch the person correctly (je → tu, mon → ton) and say it right the first time, with no mock slips. The student sees full corrections on screen. Mention an error aloud only if it is major and keeps recurring.
Correction style "explicit": name the single most important error briefly in speech, then carry on.

If the context shows they are repeating a past mistake, point that out kindly.

## Activities
- conversation: natural chat about their life, work, interests and plans. Steer topics so they practise their focus areas; for past tenses, ask about last weekend.
- roleplay: play the other character in the scenario, in French, and stay in character. Step out briefly to help only if they are stuck (in English at A2).
- lesson: teach one grammar point. Give a short explanation with one or two examples, have them produce their own sentences, check them, and build up one idea at a time.
- oral_quiz: ask one question at a time drawn from their recurring mistakes and vocabulary (fill a gap, choose between two forms, conjugate, translate a short sentence). Say whether each answer is right and why, then ask the next. Keep a light running score.
- placement: a friendly assessment interview of about twelve exchanges. Start at A1–A2 and escalate through passé composé vs imparfait, futur, conditionnel, opinions with reasons, subjonctif and hypotheticals, to find where they start to break down. Teach very little during placement; just note errors.

## Vocabulary
In "vocabulary", list up to three useful words or expressions from this turn that are new or slightly above their level: the French, its English meaning, and a short French example sentence. Leave it empty if nothing qualifies.

Be encouraging and specific, the way a great human tutor is. You can't see the student or do anything outside this conversation, so don't pretend to. The student is waiting to hear you, so begin your answer immediately.`;
}

export const SESSION_START_NOTE =
  "(The session is starting now. Greet the student briefly and begin today's activity. Speak first; the student hasn't said anything yet.)";

function activity(session: Pick<Session, "mode" | "scenarioId" | "topic">): string {
  switch (session.mode) {
    case "roleplay": {
      const s = ROLEPLAY_SCENARIOS.find((x) => x.id === session.scenarioId);
      return s ? `roleplay "${s.title}" (${s.level}): ${s.brief}` : "roleplay: pick a realistic everyday scenario suited to their level";
    }
    case "lesson":
      return `lesson on ${session.topic || "the most useful focus area for their level"}`;
    case "conversation":
      return session.topic ? `conversation about ${session.topic}` : "conversation";
    case "oral_quiz":
      return "oral_quiz on their recurring mistakes and recent vocabulary";
    case "placement":
      return "placement interview (level check)";
  }
}

const mistakeLine = (m: MistakeRecord) => `"${m.original}" → "${m.corrected}" (${CATEGORY_LABELS[m.category]})`;

export function turnContext(
  profile: LearnerProfile,
  session: Pick<Session, "mode" | "scenarioId" | "topic">,
  recalled: RecalledMistakes,
  input: InputMethod | null,
): string {
  const lines = [`Student name: ${profile.name || "not known yet (ask naturally when it fits)"}`];
  const estimates = profile.levels
    ? ` Latest estimates: speaking ${profile.levels.speaking}, grammar ${profile.levels.grammar}, vocabulary ${profile.levels.vocabulary}.`
    : "";
  lines.push(`Level: ${profile.currentLevel}, working towards ${profile.targetLevel}.${estimates}`);
  if (profile.goals) lines.push(`Goals: ${profile.goals}`);
  lines.push(`Correction style: ${profile.correctionStyle}`);
  lines.push(`Activity: ${activity(session)}`);
  if (input === "voice") lines.push("Input: the student spoke; their message is a verbatim speech-recognition transcript.");
  if (input === "text") lines.push("Input: the student typed their message.");
  if (profile.focusAreas.length) lines.push(`Focus areas from recent reviews: ${profile.focusAreas.join("; ")}`);
  if (profile.nextSessionPlan) lines.push(`Plan from the last review: ${profile.nextSessionPlan}`);
  if (recalled.recurring.length) {
    lines.push(`Recurring mistakes:\n${recalled.recurring.map((m) => `- ${mistakeLine(m)}, ${m.count} times`).join("\n")}`);
  }
  if (recalled.related.length) {
    lines.push(`Past mistakes similar to this message:\n${recalled.related.map((m) => `- ${mistakeLine(m)}`).join("\n")}`);
  }
  return `<tutor_context>\n${lines.join("\n")}\n</tutor_context>`;
}

// ---------------------------------------------------------------------------
// End-of-session review (Claude)
// ---------------------------------------------------------------------------

export const REVIEW_SYSTEM_PROMPT = `You are an experienced French teacher and DELF examiner. You are reviewing one tutoring session between an AI tutor and an adult English-speaking learner who wants to progress from A2 to B1, then B2.

Judge only the student's French, using CEFR descriptors:
- A2: simple sentences on familiar topics; present tense, passé composé with common verbs, futur proche; frequent basic errors, but the meaning is clear.
- B1: connected speech on familiar topics; narrates past events mixing passé composé and imparfait; gives opinions with reasons; uses futur simple and the conditionnel for politeness and wishes; errors rarely block understanding.
- B2: clear, detailed speech on a wide range of topics; argues a viewpoint with pros and cons; uses the subjonctif after common triggers, si-clauses, and relative pronouns such as dont and lequel; good control with occasional slips; interacts spontaneously.

Guidelines:
- Base the estimates on evidence in this transcript, weighed against the previous estimates. Move a level only when the session clearly shows it. A short session is weak evidence, so say so in levelNotes.
- The tutor's corrections are a draft. Verify them, and don't repeat any that are wrong.
- Spoken turns come from speech recognition, so ignore spelling, accents and punctuation in them.
- Quote the student's own words when you name strengths and focus areas.
- focusAreas: the two to four most valuable things to work on next, ordered by impact and phrased as actionable goals, e.g. "Use être with movement verbs in the passé composé (je suis allé, not j'ai allé)".
- nextSessionPlan: a concrete two- or three-sentence plan (activity, grammar target, vocabulary theme).
- Write summary, levelNotes, nextSessionPlan and focusAreas in English, with French examples. encouragement is one or two warm sentences in the tutor's voice.`;

export function reviewInput(profile: LearnerProfile, session: Session): string {
  const transcript = session.turns
    .filter((t) => t.role !== "note")
    .map((t) =>
      t.role === "student"
        ? `STUDENT (${t.inputMethod === "voice" ? "spoken" : "typed"}): ${t.text}`
        : `TUTOR: ${t.reply ? speechText(t.reply) : t.text}`,
    )
    .join("\n");
  const corrections =
    session.turns
      .flatMap((t) => t.reply?.corrections ?? [])
      .map((c) => `- "${c.original}" → "${c.corrected}" [${c.category}, ${c.severity}] ${c.explanation}`)
      .join("\n") || "(none)";

  return `Previous profile:
- Current level: ${profile.currentLevel}, target ${profile.targetLevel}
- Previous estimates: ${profile.levels ? `overall ${profile.levels.overall}, speaking ${profile.levels.speaking}, grammar ${profile.levels.grammar}, vocabulary ${profile.levels.vocabulary}` : "none yet"}
- Previous focus areas: ${profile.focusAreas.join("; ") || "none yet"}
- Goals: ${profile.goals || "not stated"}

Session activity: ${activity(session)}

<transcript>
${transcript}
</transcript>

<tutor_corrections>
${corrections}
</tutor_corrections>`;
}

// ---------------------------------------------------------------------------
// Written quiz (Gemini)
// ---------------------------------------------------------------------------

export function quizPrompt(profile: LearnerProfile, mistakes: MistakeRecord[], vocab: ReviewCard[], count: number): string {
  const topMistakes = [...mistakes]
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 15)
    .map((m) => `- ${mistakeLine(m)}, ${m.count}×: ${m.explanation}`)
    .join("\n");
  const recentVocab = [...vocab]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 15)
    .map((c) => `- ${c.answer} = ${c.prompt}`)
    .join("\n");

  return `You write French practice questions for an adult English-speaking learner at CEFR ${profile.currentLevel}, aiming for ${profile.targetLevel}.

Write exactly ${count} questions.
${topMistakes ? `Most should target these mistakes from the learner's history:\n${topMistakes}` : `The learner has no mistake history yet. Cover core ${profile.currentLevel}→${profile.targetLevel} grammar: passé composé vs imparfait, être vs avoir, articles and contractions, object pronouns, y and en, futur simple, conditionnel.`}
${recentVocab ? `Include a few questions on this recent vocabulary:\n${recentVocab}` : ""}
${profile.focusAreas.length ? `Current focus areas: ${profile.focusAreas.join("; ")}` : ""}

Rules:
- Each question tests one point. Mix the types:
  - multiple_choice: 3 or 4 options with exactly one correct; "answer" must equal one option exactly.
  - fill_blank: a French sentence with "___" for one gap; the answer is only the missing word(s); options is empty.
  - translate: a short English sentence to put into French; list common valid variants in acceptedAnswers; options is empty.
- Write the instruction in English and the content in French, e.g. "Choose the correct form: Hier, je ___ au cinéma."
- All French must be correct, natural, standard French. Check every answer. If a question could have more than one correct answer, list all of them in acceptedAnswers or rewrite the question.
- acceptedAnswers always includes the answer.
- Don't reuse the learner's sentences word for word; write fresh examples of the same pattern.
- explanation: one or two English sentences stating the rule.
- category: one of ${ERROR_CATEGORIES.join(", ")}.`;
}
