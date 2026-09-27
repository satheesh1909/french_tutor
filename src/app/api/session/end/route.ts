import { NextResponse } from "next/server";
import { reviewSession } from "@/lib/brain";
import { config } from "@/lib/config";
import { errorResponse } from "@/lib/http";
import { recordCorrections } from "@/lib/learner";
import { readProfile, readSession, withLock, writeProfile, writeSession } from "@/lib/store";
import { CEFR_LEVELS, type Correction, type LearnerProfile, type Session, type SessionReview } from "@/lib/types";

/** How much the student actually said, which decides whether this session may move their level. */
function studentEffort(session: Session): { turns: number; words: number } {
  const spoken = session.turns.filter((t) => t.role === "student");
  return {
    turns: spoken.length,
    words: spoken.reduce((n, t) => n + (t.text ?? "").trim().split(/\s+/).filter(Boolean).length, 0),
  };
}

/**
 * The corrections the review is willing to stand behind. The tutor drafts corrections during the
 * session but nothing is saved then, because a wrong correction in the mistake history is drilled
 * for weeks; this is the only way in.
 */
function keptCorrections(review: SessionReview, drafted: number): Correction[] {
  const ruled = review.verifiedCorrections ?? [];
  // An empty ruling when the tutor drafted something means the model ignored the instruction, not
  // that every correction was bad. Say so loudly rather than quietly throwing the session away.
  if (drafted > 0 && ruled.length === 0) {
    console.warn(`Review returned no verdicts for ${drafted} correction(s); none were saved. Check REVIEW_SYSTEM_PROMPT.`);
    return [];
  }
  return ruled
    .filter((c) => c.verdict !== "wrong")
    .map(({ original, corrected, category, severity, explanation }) => ({ original, corrected, category, severity, explanation }));
}

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

    const drafted = session.turns.flatMap((t) => t.reply?.corrections ?? []).length;
    const kept = keptCorrections(review, drafted);
    // Before the profile, so a failure here can't leave the session marked reviewed with nothing saved.
    if (kept.length > 0) await recordCorrections(session.id, kept);

    const effort = studentEffort(session);
    const enoughToJudge = effort.words >= config.minWordsForLevel && effort.turns >= config.minTurnsForLevel;

    const profile = await withLock(async () => {
      const latest = (await readSession(session.id)) ?? session;
      await writeSession({ ...latest, endedAt: now, review });

      const current = await readProfile();
      const levels = enoughToJudge ? review.levels : current.levels;
      const levelIndex = CEFR_LEVELS.indexOf(levels?.overall ?? current.currentLevel);
      // Reaching the target moves the goal up a level: A2 → B1 → B2 and beyond.
      const targetLevel =
        levelIndex >= CEFR_LEVELS.indexOf(current.targetLevel)
          ? CEFR_LEVELS[Math.min(levelIndex + 1, CEFR_LEVELS.length - 1)]
          : current.targetLevel;
      const next: LearnerProfile = {
        ...current,
        // A short session still gives advice and encouragement; it just doesn't get to restate the level.
        currentLevel: enoughToJudge ? review.levels.overall : current.currentLevel,
        targetLevel,
        levels,
        levelNotes: review.levelNotes,
        focusAreas: review.focusAreas,
        nextSessionPlan: review.nextSessionPlan,
        updatedAt: now,
      };
      await writeProfile(next);
      return next;
    });

    return NextResponse.json({
      review,
      profile,
      corrections: { drafted, kept: kept.length },
      level: { moved: enoughToJudge, ...effort, minWords: config.minWordsForLevel, minTurns: config.minTurnsForLevel },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
