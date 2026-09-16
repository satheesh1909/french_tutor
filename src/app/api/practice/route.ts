import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { GRADES, schedule, type Grade } from "@/lib/srs";
import { readCards, withLock, writeCards } from "@/lib/store";

/** Review cards that are due now. */
export async function GET() {
  try {
    const cards = await readCards();
    const now = new Date().toISOString();
    const due = cards.filter((c) => c.due <= now).sort((a, b) => a.due.localeCompare(b.due));
    const nextDue = cards.map((c) => c.due).filter((d) => d > now).sort()[0] ?? null;
    return NextResponse.json({ due: due.slice(0, 50), dueCount: due.length, total: cards.length, nextDue });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Records how well the student remembered a card and schedules its next review. */
export async function POST(req: Request) {
  try {
    const { cardId, grade } = (await req.json().catch(() => ({}))) as { cardId?: unknown; grade?: unknown };
    if (!GRADES.includes(grade as Grade)) return NextResponse.json({ error: "Invalid grade." }, { status: 400 });

    const card = await withLock(async () => {
      const cards = await readCards();
      const index = cards.findIndex((c) => c.id === cardId);
      if (index === -1) return null;
      cards[index] = schedule(cards[index], grade as Grade);
      await writeCards(cards);
      return cards[index];
    });
    if (!card) return NextResponse.json({ error: "Card not found." }, { status: 404 });
    return NextResponse.json({ card });
  } catch (err) {
    return errorResponse(err);
  }
}
