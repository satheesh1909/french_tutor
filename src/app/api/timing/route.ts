import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { readTimings, recordTiming } from "@/lib/store";
import type { TurnTiming } from "@/lib/types";

/**
 * How long spoken turns actually take.
 *
 * The browser is the only place that knows the two instants that matter - when the listener decided
 * the student had stopped, and when they first heard something back - so the measuring is done there
 * and the finished figures are posted here to be kept.
 */

const limit = (v: unknown, max: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.round(Math.min(Math.max(n, 0), max));
};

export async function GET() {
  try {
    return NextResponse.json({ timings: await readTimings() });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<TurnTiming>;
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return NextResponse.json({ error: "Which session?" }, { status: 400 });
    }
    // A stopwatch reading is worth nothing if it is wrong, and these arrive from the page, so every
    // figure is clamped to something a turn could plausibly have taken.
    const timing: TurnTiming = {
      at: new Date().toISOString(),
      sessionId: body.sessionId,
      audioSec: Math.min(Math.max(typeof body.audioSec === "number" ? body.audioSec : 0, 0), 600),
      endpointMs: limit(body.endpointMs, 60_000),
      transcribeMs: limit(body.transcribeMs, 600_000),
      brainMs: limit(body.brainMs, 600_000),
      voiceMs: limit(body.voiceMs, 600_000),
      firstSoundMs: limit(body.firstSoundMs, 600_000),
      wordsMs: limit(body.wordsMs, 600_000),
      early: body.early === true,
      restarted: body.restarted === true,
      model: typeof body.model === "string" ? body.model.slice(0, 80) : "",
    };
    await recordTiming(timing);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
