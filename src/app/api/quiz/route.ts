import { NextResponse } from "next/server";
import { generateQuiz } from "@/lib/brain";
import { errorResponse } from "@/lib/http";
import { readCards, readMistakes, readProfile } from "@/lib/store";

/** A fresh written quiz built from the student's mistake history and new vocabulary. */
export async function POST(req: Request) {
  try {
    const { count, topic } = (await req.json().catch(() => ({}))) as { count?: unknown; topic?: unknown };
    const size = Math.min(15, Math.max(3, Math.round(Number(count) || 8)));
    const [profile, mistakes, cards] = await Promise.all([readProfile(), readMistakes(), readCards()]);
    const focus = typeof topic === "string" ? topic.trim().slice(0, 120) : null;
    const questions = await generateQuiz(profile, mistakes, cards.filter((c) => c.kind === "vocab"), size, focus);
    return NextResponse.json({ questions });
  } catch (err) {
    return errorResponse(err);
  }
}
