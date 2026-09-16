import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config";
import { UserFacingError } from "./http";
import { REVIEW_SYSTEM_PROMPT, reviewInput, tutorSystemPrompt } from "./prompts";
import { CEFR_LEVELS, ERROR_CATEGORIES, type LearnerProfile, type Session, type SessionReview, type TutorReply } from "./types";

// Created lazily so routes that don't need Claude still load when no key is configured.
let client: Anthropic | undefined;
const claude = () => (client ??= new Anthropic());

export const hasClaudeCredentials = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

// Corrections come before speech so Claude notices the mistakes before it phrases its reply.
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
const ReviewSchema = z.object({
  summary: z.string(),
  strengths: z.array(z.string()),
  focusAreas: z.array(z.string()),
  levelNotes: z.string(),
  levels: z.object({ overall: Level, speaking: Level, grammar: Level, vocabulary: Level }),
  nextSessionPlan: z.string(),
  encouragement: z.string(),
});

/**
 * Claude Opus 5 can decline a request; "default" fallbacks re-run a declined request server-side
 * on Anthropic's recommended model instead of failing the turn. Other models don't take the parameter.
 */
function fallbacks(model: string) {
  return /^claude-(opus-5|fable-5)/.test(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
}

/**
 * Replays the stored session. Each turn is sent exactly as it was the first time
 * (context blocks included), so the growing history stays cacheable.
 */
function toMessages(session: Session): Anthropic.Beta.BetaMessageParam[] {
  return session.turns.map((turn): Anthropic.Beta.BetaMessageParam => {
    if (turn.role === "tutor") {
      const reply: TutorReply = turn.reply ?? { corrections: [], speech: [{ lang: "en", text: turn.text }], vocabulary: [] };
      return { role: "assistant", content: JSON.stringify(reply) };
    }
    const content: Anthropic.Beta.BetaTextBlockParam[] = [];
    if (turn.context) content.push({ type: "text", text: turn.context });
    content.push({ type: "text", text: turn.text });
    return { role: "user", content };
  });
}

export async function generateTutorReply(session: Session): Promise<TutorReply> {
  const model = config.claude.tutorModel;
  const response = await claude().beta.messages.parse({
    model,
    max_tokens: 16000,
    system: [{ type: "text", text: tutorSystemPrompt(), cache_control: { type: "ephemeral" } }],
    messages: toMessages(session),
    cache_control: { type: "ephemeral" },
    output_config: { effort: config.claude.tutorEffort, format: betaZodOutputFormat(TutorReplySchema) },
    ...fallbacks(model),
  });

  if (response.stop_reason === "refusal") {
    throw new UserFacingError("The tutor couldn't answer that message. Try rephrasing it.", 422);
  }
  if (!response.parsed_output) {
    throw new Error(`Claude's reply couldn't be read (stop reason: ${response.stop_reason}).`);
  }
  return response.parsed_output;
}

export async function reviewSession(profile: LearnerProfile, session: Session): Promise<SessionReview> {
  const model = config.claude.reviewModel;
  // Streaming because a high-effort review can think for a while; this avoids HTTP timeouts.
  const stream = claude().beta.messages.stream({
    model,
    max_tokens: 64000,
    system: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: reviewInput(profile, session) }],
    output_config: { effort: config.claude.reviewEffort, format: betaZodOutputFormat(ReviewSchema) },
    ...fallbacks(model),
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    throw new UserFacingError("The session review couldn't be generated for this session.", 422);
  }
  if (!response.parsed_output) {
    throw new Error(`The session review couldn't be read (stop reason: ${response.stop_reason}).`);
  }
  return response.parsed_output;
}
