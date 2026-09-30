import { NextResponse } from "next/server";
import { generateTutorReply } from "@/lib/brain";
import { errorResponse } from "@/lib/http";
import { recallMistakes, recordVocabulary } from "@/lib/learner";
import { SESSION_START_NOTE, turnContext } from "@/lib/prompts";
import { readMaterials, readProfile, writeSession } from "@/lib/store";
import { ROLEPLAY_SCENARIOS, TUTOR_MODES, speechText, type Session, type TutorMode } from "@/lib/types";

/** Starts a session: the tutor greets the student and opens the chosen activity. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { mode?: string; scenarioId?: string | null; topic?: string | null; materialId?: string | null };
    const mode: TutorMode = TUTOR_MODES.includes(body.mode as TutorMode) ? (body.mode as TutorMode) : "conversation";
    const scenario = mode === "roleplay" ? ROLEPLAY_SCENARIOS.find((s) => s.id === body.scenarioId) : undefined;
    const now = new Date().toISOString();
    const session: Session = {
      id: crypto.randomUUID(),
      mode,
      scenarioId: scenario?.id ?? null,
      topic: body.topic?.trim().slice(0, 200) || null,
      // Checked against the library, so a session can't point at a text that isn't there.
      materialId: (await readMaterials()).some((m) => m.id === body.materialId) ? (body.materialId as string) : null,
      startedAt: now,
      endedAt: null,
      turns: [],
      review: null,
    };

    const [profile, recalled] = await Promise.all([readProfile(), recallMistakes(null)]);
    session.turns.push({ id: crypto.randomUUID(), role: "note", text: SESSION_START_NOTE, context: turnContext(profile, session, recalled, null), at: now });

    const reply = await generateTutorReply(session);
    session.turns.push({ id: crypto.randomUUID(), role: "tutor", text: speechText(reply), reply, at: new Date().toISOString() });
    await writeSession(session);
    recordVocabulary(reply.vocabulary).catch((err) => console.error("Couldn't save vocabulary", err));

    return NextResponse.json({ session });
  } catch (err) {
    return errorResponse(err);
  }
}
