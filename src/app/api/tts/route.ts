import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { resolveVoice } from "@/lib/providers/speech";
import { speech } from "@/lib/ttsCache";
import { readSettings } from "@/lib/store";
import type { SpeechSegment } from "@/lib/types";

const MAX_CHARS = 4_000;

/**
 * Turns the tutor's language-tagged speech into one WAV clip, in whichever voice is configured.
 * The page may name a voice, so the Settings page can preview a choice before saving it.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const segments = (Array.isArray(body.segments) ? body.segments : []).filter(
      (s): s is SpeechSegment =>
        typeof s === "object" && s !== null && (s.lang === "fr" || s.lang === "en") && typeof s.text === "string" && s.text.trim() !== "",
    );
    if (segments.length === 0) return NextResponse.json({ error: "Nothing to say." }, { status: 400 });
    if (segments.reduce((n, s) => n + s.text.length, 0) > MAX_CHARS) {
      return NextResponse.json({ error: "Reply too long to speak." }, { status: 413 });
    }

    const { voice } = await readSettings();
    const wav = await speech(segments, resolveVoice(body, voice));
    return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
