import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { readProfile, withLock, writeProfile } from "@/lib/store";
import { CEFR_LEVELS, type CefrLevel, type LearnerProfile } from "@/lib/types";

export async function GET() {
  try {
    return NextResponse.json({ profile: await readProfile() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Updates the settings the student controls. Level estimates and focus areas come from session reviews. */
export async function PUT(req: Request) {
  try {
    const input = (await req.json().catch(() => ({}))) as Partial<Record<keyof LearnerProfile, unknown>>;
    const level = (value: unknown, fallback: CefrLevel) => (CEFR_LEVELS.includes(value as CefrLevel) ? (value as CefrLevel) : fallback);

    const profile = await withLock(async () => {
      const current = await readProfile();
      const next: LearnerProfile = {
        ...current,
        name: typeof input.name === "string" ? input.name.trim().slice(0, 60) : current.name,
        goals: typeof input.goals === "string" ? input.goals.trim().slice(0, 600) : current.goals,
        // Given to the review so it stops inventing a life for him: see REVIEW_SYSTEM_PROMPT.
        city: typeof input.city === "string" ? input.city.trim().slice(0, 80) : current.city,
        employer: typeof input.employer === "string" ? input.employer.trim().slice(0, 80) : current.employer,
        role: typeof input.role === "string" ? input.role.trim().slice(0, 80) : current.role,
        currentLevel: level(input.currentLevel, current.currentLevel),
        targetLevel: level(input.targetLevel, current.targetLevel),
        correctionStyle: input.correctionStyle === "gentle" || input.correctionStyle === "explicit" ? input.correctionStyle : current.correctionStyle,
        updatedAt: new Date().toISOString(),
      };
      await writeProfile(next);
      return next;
    });
    return NextResponse.json({ profile });
  } catch (err) {
    return errorResponse(err);
  }
}
