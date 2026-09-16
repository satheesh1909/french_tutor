import { NextResponse } from "next/server";
import { generateQuiz } from "@/lib/brain";
import { errorResponse } from "@/lib/http";
import { readCards, readMistakes, readProfile } from "@/lib/store";

/** A fresh written quiz built from the student's mistake history and new vocabulary. */
export async function POST(req: Request) {
  try {
    const { count } = (await req.json().catch(() => ({}))) as { count?: unknown };
    const size = Math.min(15, Math.max(3, Math.round(Number(count) || 8)));
    const [profile, mistakes, cards] = await Promise.all([readProfile(), readMistakes(), readCards()]);
    const questions = await generateQuiz(profile, mistakes, cards.filter((c) => c.kind === "vocab"), size);
    return NextResponse.json({ questions });
  } catch (err) {
    return errorResponse(err);
  }
}
