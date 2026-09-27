import { NextResponse } from "next/server";
import { generateTutorReply } from "@/lib/brain";
import { sanitizeFluency } from "@/lib/fluency";
import { errorResponse } from "@/lib/http";
import { recallMistakes, recordVocabulary } from "@/lib/learner";
import { turnContext } from "@/lib/prompts";
import { readProfile, readSession, withLock, writeSession } from "@/lib/store";
import { speechText, type ChatTurn, type HeardLanguage, type InputMethod } from "@/lib/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// In hands-free mode the student can keep talking after an answer has been sent. The browser then
// cancels that request and sends the combined answer, listing the ids it replaces. Remember them, so a
// replaced request that finishes late isn't saved. Kept on globalThis because Next.js may load this module twice in dev.
const holder = globalThis as unknown as { __supersededTurns?: Set<string> };
const superseded = (holder.__supersededTurns ??= new Set<string>());

function markSuperseded(ids: string[]) {
  for (const id of ids) superseded.add(id);
  for (const id of superseded) {
    if (superseded.size <= 500) break;
    superseded.delete(id);
  }
}

/** The browser's report of which language the recording was in, narrowed to what we'll store. */
function heardLanguage(value: unknown): HeardLanguage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { language, certain } = value as { language?: unknown; certain?: unknown };
  if (language !== "fr" && language !== "en") return undefined;
  return { language, certain: certain === true };
}

/** Removes replaced student answers, and the tutor reply that followed each, from a transcript. */
function withoutSuperseded(turns: ChatTurn[], ids: Set<string>): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let dropReply = false;
  for (const turn of turns) {
    if (turn.role === "student" && turn.clientTurnId && ids.has(turn.clientTurnId)) {
      dropReply = true;
      continue;
    }
    if (dropReply && turn.role === "tutor") {
      dropReply = false;
      continue;
    }
    dropReply = false;
    kept.push(turn);
  }
  return kept;
}

/** One conversational exchange: the student's message in, the tutor's reply and corrections out. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      sessionId?: unknown;
      text?: unknown;
      inputMethod?: unknown;
      fluency?: unknown;
      clientTurnId?: unknown;
      supersedes?: unknown;
      heard?: unknown;
    };
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!text) return NextResponse.json({ error: "Say or type something first." }, { status: 400 });
    if (typeof body.sessionId !== "string") return NextResponse.json({ error: "Session not found. Start a new one." }, { status: 404 });

    const clientTurnId = isUuid(body.clientTurnId) ? body.clientTurnId : undefined;
    const replaces = Array.isArray(body.supersedes) ? body.supersedes.filter(isUuid).slice(0, 20) : [];
    markSuperseded(replaces);

    // If a replaced answer was already saved (the browser stopped waiting for it), take it out again.
    const session = await withLock(async () => {
      const found = await readSession(body.sessionId as string);
      if (!found || replaces.length === 0) return found;
      const turns = withoutSuperseded(found.turns, new Set(replaces));
      if (turns.length === found.turns.length) return found;
      const cleaned = { ...found, turns };
      await writeSession(cleaned);
      return cleaned;
    });
    if (!session) return NextResponse.json({ error: "Session not found. Start a new one." }, { status: 404 });
    if (session.endedAt) return NextResponse.json({ error: "This session has ended. Start a new one." }, { status: 409 });

    const inputMethod: InputMethod = body.inputMethod === "voice" ? "voice" : "text";
    const [profile, recalled] = await Promise.all([readProfile(), recallMistakes(text)]);
    const studentTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: "student",
      text,
      inputMethod,
      clientTurnId,
      fluency: inputMethod === "voice" ? sanitizeFluency(body.fluency) : undefined,
      heard: inputMethod === "voice" ? heardLanguage(body.heard) : undefined,
      context: turnContext(profile, session, recalled, inputMethod),
      at: new Date().toISOString(),
    };

    // The request's signal fires if the browser cancels, which also stops the model call.
    const reply = await generateTutorReply({ ...session, turns: [...session.turns, studentTurn] }, req.signal);
    const tutorTurn: ChatTurn = { id: crypto.randomUUID(), role: "tutor", text: speechText(reply), reply, at: new Date().toISOString() };

    if (req.signal.aborted || (clientTurnId && superseded.has(clientTurnId))) {
      return NextResponse.json({ error: "Replaced by a newer answer." }, { status: 409 });
    }

    // Both turns are saved only once the reply exists, so a failed call can simply be retried.
    await withLock(async () => {
      const latest = (await readSession(session.id)) ?? session;
      latest.turns.push(studentTurn, tutorTurn);
      await writeSession(latest);
    });

    // Corrections are NOT recorded here. They are a draft: the end-of-session review rules on each
    // one before any of it reaches the mistake history, because a wrong correction that gets in is
    // then drilled for weeks. They still show on screen, from turn.reply.corrections in the session.
    // Vocabulary is safe to keep straight away, and the embeddings shouldn't delay her voice.
    recordVocabulary(reply.vocabulary).catch((err) => console.error("Couldn't update learner history", err));

    return NextResponse.json({ studentTurn, tutorTurn });
  } catch (err) {
    if (req.signal.aborted) return NextResponse.json({ error: "Cancelled." }, { status: 499 });
    return errorResponse(err);
  }
}
