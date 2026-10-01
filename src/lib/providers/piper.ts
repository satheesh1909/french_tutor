import { config } from "../config";
import { UserFacingError } from "../http";
import type { PiperStatus, SpeechSegment } from "../types";

// Talks to the local voice server in piper_server/server.py, which speaks her replies on the CPU,
// several times faster than real time. Each Piper voice knows one language, so she uses two: the
// French one for French, the English one for the explanations.

const OFFLINE: PiperStatus = { online: false, starting: false, voices: [], loaded: [], defaults: { fr: "", en: "" }, problem: null };

export async function piperStatus(): Promise<PiperStatus> {
  try {
    const res = await fetch(`${config.piper.url}/health`, { signal: AbortSignal.timeout(1_500) });
    const data = (await res.json().catch(() => ({}))) as Partial<PiperStatus> & { ok?: boolean; error?: string };
    // A running server that can't work (no voices installed, say) is worth reporting as such, so the
    // student isn't sent off to start something that is already started.
    if (!res.ok) return { ...OFFLINE, starting: Boolean(data.starting), problem: data.error ?? null };
    return {
      online: true,
      starting: false,
      voices: data.voices ?? [],
      loaded: data.loaded ?? [],
      defaults: { fr: data.defaults?.fr ?? "", en: data.defaults?.en ?? "" },
      problem: null,
    };
  } catch {
    return OFFLINE;
  }
}

/**
 * Asks the voice server to load a pair of voices now. Loading one costs about four seconds, and it
 * used to be paid inside the first reply of the session: the server warmed its own alphabetical
 * defaults at start-up, which are not the voices the app asks for. Already-loaded voices cost
 * nothing, so this is safe to call whenever the configuration might have changed.
 */
export async function piperWarm(voices: { fr: string; en: string }): Promise<string[]> {
  const res = await fetch(`${config.piper.url}/warm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voices }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = (await res.json().catch(() => ({}))) as { loaded?: string[]; error?: string };
  if (!res.ok) throw new Error(data.error ?? `The voice server wouldn't warm up (${res.status}).`);
  return data.loaded ?? [];
}

/** Speaks one reply. Returns a mono 16-bit WAV, which the browser and the lip-sync server both take. */
export async function piperSynthesize(
  segments: SpeechSegment[],
  voices: { fr: string; en: string },
  speeds?: { fr: number; en: number },
): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(`${config.piper.url}/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ segments, voices, speeds }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new UserFacingError('The voice server isn\'t running. Start it with "npm run piper", or choose a different voice in Settings.', 503);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new UserFacingError(data.error ?? `The voice server failed (${res.status}).`, 502);
  }
  return Buffer.from(await res.arrayBuffer());
}
