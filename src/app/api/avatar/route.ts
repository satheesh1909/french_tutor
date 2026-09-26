import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { animate } from "@/lib/providers/avatar";
import { cacheVideo, cachedVideo, speech } from "@/lib/ttsCache";
import { readSettings } from "@/lib/store";
import { GEMINI_VOICES, type SpeechSegment } from "@/lib/types";

const MAX_CHARS = 4_000;

/**
 * Speaks the tutor's reply and animates her photo saying it, in one round trip: Gemini makes the
 * audio, the local lip-sync server makes the picture, and the browser gets one mp4 with both.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { segments?: unknown; voice?: unknown; model?: unknown };
    const segments = (Array.isArray(body.segments) ? body.segments : []).filter(
      (s): s is SpeechSegment =>
        typeof s === "object" && s !== null && (s.lang === "fr" || s.lang === "en") && typeof s.text === "string" && s.text.trim() !== "",
    );
    if (segments.length === 0) return NextResponse.json({ error: "Nothing to say." }, { status: 400 });
    if (segments.reduce((n, s) => n + s.text.length, 0) > MAX_CHARS) {
      return NextResponse.json({ error: "Reply too long to speak." }, { status: 413 });
    }

    const { voice, avatar } = await readSettings();
    const voiceName = GEMINI_VOICES.some((v) => v.name === body.voice) ? (body.voice as string) : voice.geminiVoice;
    const model = typeof body.model === "string" && /^gemini-[\w.-]+$/.test(body.model) ? body.model : voice.geminiModel;

    const face = avatar.photo || "charlotte";
    const reuse = await cachedVideo(segments, { model, voice: voiceName, face });
    if (reuse) return new Response(new Uint8Array(reuse), { headers: { "content-type": "video/mp4", "cache-control": "no-store" } });

    const wav = await speech(segments, { model, voice: voiceName });
    const video = await animate(wav, face);
    void cacheVideo(segments, { model, voice: voiceName, face }, video);
    return new Response(new Uint8Array(video), { headers: { "content-type": "video/mp4", "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
