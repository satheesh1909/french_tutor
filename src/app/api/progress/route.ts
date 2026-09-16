import { NextResponse } from "next/server";
import { averageFluency, type FluencyStats } from "@/lib/fluency";
import { errorResponse } from "@/lib/http";
import { readAllSessions, readCards, readMistakes, readProfile, summarizeSession } from "@/lib/store";
import type { ErrorCategory } from "@/lib/types";

const DAY_MS = 86_400_000;

export async function GET() {
  try {
    const [profile, mistakes, cards, sessions] = await Promise.all([readProfile(), readMistakes(), readCards(), readAllSessions()]);

    const totals = new Map<ErrorCategory, number>();
    for (const m of mistakes) totals.set(m.category, (totals.get(m.category) ?? 0) + m.count);
    const categories = [...totals].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);

    const topMistakes = [...mistakes].sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)).slice(0, 10);
    const now = new Date();

    // Speaking speed over time, from every spoken turn.
    const spoken: { at: number; fluency: FluencyStats }[] = sessions.flatMap((s) =>
      s.turns.flatMap((t) => (t.fluency ? [{ at: new Date(t.at).getTime(), fluency: t.fluency }] : [])),
    );
    const between = (from: number, to: number) => averageFluency(spoken.filter((x) => x.at >= from && x.at < to).map((x) => x.fluency));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = now.getTime() + 1;

    return NextResponse.json({
      profile,
      sessions: sessions.map(summarizeSession),
      categories,
      topMistakes,
      mistakeCount: mistakes.reduce((n, m) => n + m.count, 0),
      cards: {
        total: cards.length,
        due: cards.filter((c) => c.due <= now.toISOString()).length,
        mature: cards.filter((c) => c.intervalDays >= 21).length,
      },
      speaking: {
        today: between(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), end),
        week: between(end - 7 * DAY_MS, end),
        previousWeek: between(end - 14 * DAY_MS, end - 7 * DAY_MS),
        month: between(monthStart, end),
        allTime: averageFluency(spoken.map((x) => x.fluency)),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
