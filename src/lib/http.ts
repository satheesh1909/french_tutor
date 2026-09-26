import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

/** An error whose message is safe and useful to show the student as-is. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const json = (status: number, error: string) => NextResponse.json({ error }, { status });

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof UserFacingError) return json(err.status, err.message);
  console.error(err);

  if (err instanceof Anthropic.AuthenticationError) {
    return json(401, "Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.local and restart the app.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return json(429, "Claude is busy (rate limit). Wait a few seconds and try again.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return json(502, "Couldn't reach Claude. Check your internet connection.");
  }
  if (err instanceof Anthropic.APIError) {
    return json(502, `Claude API error ${err.status}: ${err.message}`);
  }
  if (err instanceof Anthropic.AnthropicError) {
    return json(503, `Claude isn't set up: ${err.message}. Add ANTHROPIC_API_KEY to .env.local and restart the app.`);
  }

  // @google/genai errors carry the HTTP status of the failed call.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    const message = (err as Error).message ?? "";
    if (status === 429 && /per_?day|PerDay|requests_per_model_per_day/i.test(message)) {
      const hours = /retry in (\d+)h/i.exec(message)?.[1];
      const model = /model: ([\w.-]+)/i.exec(message)?.[1];
      return json(
        429,
        `Gemini's free daily limit for ${model ?? "this model"} is used up${hours ? `; it resets in about ${hours} hours` : ""}. ` +
          "The tutor carries on with what's still available, and her voice falls back to your computer's own.",
      );
    }
    if (status === 429) return json(429, "Gemini is rate-limiting requests. Wait a few seconds and try again.");
    return json(502, `Gemini API error ${status}: ${message}`);
  }
  return json(500, err instanceof Error ? err.message : "Something went wrong.");
}
