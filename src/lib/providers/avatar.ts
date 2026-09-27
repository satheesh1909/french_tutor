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

export interface AddedFace {
  name: string;
  width: number;
  height: number;
  /** Every face the server now knows, so the page can offer the new one straight away. */
  faces: string[];
}

/**
 * Gives the lip-sync server a new portrait. The server owns the faces folder and is the only thing
 * that can find a face in a photo, so the bytes go to it rather than being written here - which also
 * means a photo with no face in it is refused instead of sitting in the folder waiting to fail.
 *
 * Finding the face takes about fifteen seconds, hence the generous timeout.
 */
export async function addFace(name: string, image: Buffer): Promise<AddedFace> {
  let res: Response;
  try {
    res = await fetch(`${config.avatar.url}/faces?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(image),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new UserFacingError(
      "The avatar server isn't running, and it is the part that finds the face in a photo. Start it with \"npm run avatar\", then try again.",
      503,
    );
  }
  const data = (await res.json().catch(() => ({}))) as Partial<AddedFace> & { error?: string };
  if (!res.ok) throw new UserFacingError(data.error ?? `The avatar server refused that photo (${res.status}).`, res.status === 413 ? 413 : 400);
  return { name: data.name ?? name, width: data.width ?? 0, height: data.height ?? 0, faces: data.faces ?? [] };
}

/**
 * Forgets a portrait and deletes it. The server refuses to remove the last one, because it would
 * have nothing left to animate.
 */
export async function removeFace(name: string): Promise<{ name: string; faces: string[] }> {
  let res: Response;
  try {
    res = await fetch(`${config.avatar.url}/faces?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new UserFacingError("The avatar server isn't running, so it can't remove a photo. Start it with \"npm run avatar\".", 503);
  }
  const data = (await res.json().catch(() => ({}))) as { name?: string; faces?: string[]; error?: string };
  if (!res.ok) throw new UserFacingError(data.error ?? `The avatar server refused that (${res.status}).`, 400);
  return { name: data.name ?? name, faces: data.faces ?? [] };
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
