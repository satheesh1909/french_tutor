import { NextResponse } from "next/server";
import { reviewSession } from "@/lib/claude";
import { errorResponse } from "@/lib/http";
import { readProfile, readSession, withLock, writeProfile, writeSession } from "@/lib/store";
import { CEFR_LEVELS, type LearnerProfile } from "@/lib/types";

/** Ends a session: Claude reviews it, and the learner profile takes on the new estimates and focus areas. */
export async function POST(req: Request) {
  try {
    const { sessionId } = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
    const session = typeof sessionId === "string" ? await readSession(sessionId) : null;
    if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    if (session.review) return NextResponse.json({ review: session.review, profile: await readProfile() });

    const now = new Date().toISOString();
    if (!session.turns.some((t) => t.role === "student")) {
      await withLock(() => writeSession({ ...session, endedAt: now }));
      return NextResponse.json({ review: null, profile: await readProfile() });
    }

    const review = await reviewSession(await readProfile(), session);

    const profile = await withLock(async () => {
      const latest = (await readSession(session.id)) ?? session;
      await writeSession({ ...latest, endedAt: now, review });

      const current = await readProfile();
      const levelIndex = CEFR_LEVELS.indexOf(review.levels.overall);
      // Reaching the target moves the goal up a level: A2 → B1 → B2 and beyond.
      const targetLevel =
        levelIndex >= CEFR_LEVELS.indexOf(current.targetLevel)
          ? CEFR_LEVELS[Math.min(levelIndex + 1, CEFR_LEVELS.length - 1)]
          : current.targetLevel;
      const next: LearnerProfile = {
        ...current,
        currentLevel: review.levels.overall,
        targetLevel,
        levels: review.levels,
        levelNotes: review.levelNotes,
        focusAreas: review.focusAreas,
        nextSessionPlan: review.nextSessionPlan,
        updatedAt: now,
      };
      await writeProfile(next);
      return next;
    });

    return NextResponse.json({ review, profile });
  } catch (err) {
    return errorResponse(err);
  }
}
