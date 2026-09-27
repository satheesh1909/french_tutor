import { config } from "../config";
import { UserFacingError } from "../http";
import type { SpeechSegment, XttsStatus } from "../types";

// Talks to the local voice server in voice_server/server.py, which speaks her replies with XTTS-v2
// on the GPU. One voice covers both French and English, nothing leaves the computer, and there is
// no daily limit — which is the whole point of it.

const OFFLINE: XttsStatus = { online: false, starting: false, device: null, speakers: [], voices: [], default: null, problem: null };

export async function xttsStatus(): Promise<XttsStatus> {
  try {
    const res = await fetch(`${config.xtts.url}/health`, { signal: AbortSignal.timeout(1_500) });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      starting?: boolean;
      error?: string;
      device?: string;
      speakers?: string[];
      voices?: string[];
      default?: string;
    };
    // A running server that can't work (an unaccepted licence, say) is worth reporting as such,
    // because "not running" would send the student off to start something that is already started.
    if (!res.ok) return { ...OFFLINE, starting: Boolean(data.starting), problem: data.error ?? null };
    return {
      online: true,
      starting: false,
      device: data.device ?? null,
      speakers: data.speakers ?? [],
      voices: data.voices ?? [],
      default: data.default ?? null,
      problem: null,
    };
  } catch {
    return OFFLINE;
  }
}

/** Speaks one reply. Returns a mono 16-bit WAV, which the browser and the lip-sync server both take. */
export async function xttsSynthesize(segments: SpeechSegment[], speaker: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(`${config.xtts.url}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ segments, speaker }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new UserFacingError('The voice server isn\'t running. Start it with "npm run voice", or choose a different voice in Settings.', 503);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new UserFacingError(data.error ?? `The voice server failed (${res.status}).`, 502);
  }
  return Buffer.from(await res.arrayBuffer());
}
