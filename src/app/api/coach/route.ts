import { NextResponse } from "next/server";
import { answerCoachQuestion } from "@/lib/brain";
import { errorResponse, UserFacingError } from "@/lib/http";
import { readAllSessions, readCards, readMistakes, readProfile } from "@/lib/store";
import type { CoachTurn } from "@/lib/types";

/** How much of the conversation is replayed to the coach. */
const MAX_TURNS = 12;

/** Questions about the student's own level, answered from their reviews, mistakes and speed. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { messages?: unknown };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const history: CoachTurn[] = messages
      .filter((m): m is CoachTurn => Boolean(m) && typeof (m as CoachTurn).text === "string")
      .map((m): CoachTurn => ({ role: m.role === "coach" ? "coach" : "student", text: m.text.trim().slice(0, 2000) }))
      .filter((m) => m.text)
      .slice(-MAX_TURNS);
    if (history.length === 0 || history[history.length - 1].role !== "student") {
      throw new UserFacingError("Ask a question first.", 400);
    }

    const [profile, mistakes, cards, sessions] = await Promise.all([readProfile(), readMistakes(), readCards(), readAllSessions()]);
    const answer = await answerCoachQuestion(profile, sessions, mistakes, cards, history);
    return NextResponse.json(answer);
  } catch (err) {
    return errorResponse(err);
  }
}
