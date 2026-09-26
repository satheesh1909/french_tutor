import { config } from "../config";
import { UserFacingError } from "../http";

// Talks to the local lip-sync server in avatar_server/server.py, which turns her voice into a
// short video of her photo speaking. It runs on the GPU alongside Whisper.

export interface AvatarStatus {
  online: boolean;
  /** Still loading the model and warming the GPU; try again in a moment. */
  starting: boolean;
  device: string | null;
  faces: string[];
}

export async function avatarStatus(): Promise<AvatarStatus> {
  try {
    const res = await fetch(`${config.avatar.url}/health`, { signal: AbortSignal.timeout(1_500) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; starting?: boolean; device?: string; faces?: string[] };
    if (!res.ok) return { online: false, starting: Boolean(data.starting), device: null, faces: [] };
    return { online: true, starting: false, device: data.device ?? null, faces: data.faces ?? [] };
  } catch {
    return { online: false, starting: false, device: null, faces: [] };
  }
}

/** Renders one reply. Returns an mp4 with her voice already in it. */
export async function animate(wav: Buffer, face?: string): Promise<Buffer> {
  const query = face ? `?face=${encodeURIComponent(face)}` : "";
  let res: Response;
  try {
    res = await fetch(`${config.avatar.url}/animate${query}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new UserFacingError(
      'The avatar server isn\'t running. Start it with "npm run avatar", or choose a different avatar in Settings.',
      503,
    );
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new UserFacingError(data.error ?? `The avatar server failed (${res.status}).`, 502);
  }
  return Buffer.from(await res.arrayBuffer());
}
