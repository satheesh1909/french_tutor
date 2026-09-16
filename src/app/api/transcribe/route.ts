import { NextResponse } from "next/server";
import { transcribe } from "@/lib/gemini";
import { errorResponse } from "@/lib/http";

const MAX_BYTES = 12 * 1024 * 1024; // about six minutes of 16 kHz speech

/** Receives a WAV recording from the browser and returns what the student said, mistakes included. */
export async function POST(req: Request) {
  try {
    const audio = Buffer.from(await req.arrayBuffer());
    if (audio.length < 2_000) return NextResponse.json({ error: "The recording was empty." }, { status: 400 });
    if (audio.length > MAX_BYTES) {
      return NextResponse.json({ error: "That recording is too long. Keep each turn under a few minutes." }, { status: 413 });
    }
    return NextResponse.json({ text: await transcribe(audio) });
  } catch (err) {
    return errorResponse(err);
  }
}
