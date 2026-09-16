import { NextResponse } from "next/server";
import { generateTutorReply } from "@/lib/brain";
import { sanitizeFluency } from "@/lib/fluency";
import { errorResponse } from "@/lib/http";
import { recallMistakes, recordCorrections, recordVocabulary } from "@/lib/learner";
import { turnContext } from "@/lib/prompts";
import { readProfile, readSession, withLock, writeSession } from "@/lib/store";
import { speechText, type ChatTurn, type InputMethod } from "@/lib/types";

/** One conversational exchange: the student's message in, the tutor's reply and corrections out. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown; text?: unknown; inputMethod?: unknown; fluency?: unknown };
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
    if (!text) return NextResponse.json({ error: "Say or type something first." }, { status: 400 });

    const session = typeof body.sessionId === "string" ? await readSession(body.sessionId) : null;
    if (!session) return NextResponse.json({ error: "Session not found. Start a new one." }, { status: 404 });
    if (session.endedAt) return NextResponse.json({ error: "This session has ended. Start a new one." }, { status: 409 });

    const inputMethod: InputMethod = body.inputMethod === "voice" ? "voice" : "text";
    const [profile, recalled] = await Promise.all([readProfile(), recallMistakes(text)]);
    const studentTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: "student",
      text,
      inputMethod,
      fluency: inputMethod === "voice" ? sanitizeFluency(body.fluency) : undefined,
      context: turnContext(profile, session, recalled, inputMethod),
      at: new Date().toISOString(),
    };

    const reply = await generateTutorReply({ ...session, turns: [...session.turns, studentTurn] });
    const tutorTurn: ChatTurn = { id: crypto.randomUUID(), role: "tutor", text: speechText(reply), reply, at: new Date().toISOString() };

    // Both turns are saved only once the reply exists, so a failed call can simply be retried.
    await withLock(async () => {
      const latest = (await readSession(session.id)) ?? session;
      latest.turns.push(studentTurn, tutorTurn);
      await writeSession(latest);
    });

    // Updating the mistake history (with Ollama embeddings) shouldn't delay the tutor's voice.
    Promise.all([recordCorrections(session.id, reply.corrections), recordVocabulary(reply.vocabulary)]).catch((err) =>
      console.error("Couldn't update learner history", err),
    );

    return NextResponse.json({ studentTurn, tutorTurn });
  } catch (err) {
    return errorResponse(err);
  }
}
