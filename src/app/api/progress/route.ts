import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { listSessions, readCards, readMistakes, readProfile } from "@/lib/store";
import type { ErrorCategory } from "@/lib/types";

export async function GET() {
  try {
    const [profile, mistakes, cards, sessions] = await Promise.all([readProfile(), readMistakes(), readCards(), listSessions()]);

    const totals = new Map<ErrorCategory, number>();
    for (const m of mistakes) totals.set(m.category, (totals.get(m.category) ?? 0) + m.count);
    const categories = [...totals].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);

    const topMistakes = [...mistakes].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)).slice(0, 10);
    const now = new Date().toISOString();

    return NextResponse.json({
      profile,
      sessions,
      categories,
      topMistakes,
      mistakeCount: mistakes.reduce((n, m) => n + m.count, 0),
      cards: {
        total: cards.length,
        due: cards.filter((c) => c.due <= now).length,
        mature: cards.filter((c) => c.intervalDays >= 21).length,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
