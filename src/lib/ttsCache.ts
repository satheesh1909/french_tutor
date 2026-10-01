import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import { synthesizeWith, type VoiceChoice } from "./providers/speech";
import type { SpeechSegment } from "./types";

/**
 * Gemini's free tier allows a hundred speech requests a day, and the tutor repeats herself: you
 * replay a reply, you preview the same sample sentence, she greets you the same way. So every clip
 * is kept on disk under its own hash, and saying the same thing again costs nothing.
 *
 * The rendered video is kept beside it, because that is the same work twice over.
 */

const DIR = path.join(config.dataDir, "speech-cache");
const MAX_FILES = 400;

function key(segments: SpeechSegment[], choice: VoiceChoice): string {
  const text = segments.map((s) => `${s.lang}:${s.text.trim()}`).join("|");
  // Gemini clips keep the key they were saved under, so a cache filled before the local voice
  // existed still counts - which matters, because a used-up daily quota can't refill it.
  const who = choice.provider === "gemini" ? `${choice.model}|${choice.voice}` : `${choice.provider}|${choice.voice}`;
  return createHash("sha256").update(`${who}|${text}`).digest("hex").slice(0, 32);
}

async function read(file: string): Promise<Buffer | null> {
  try {
    const data = await fs.readFile(file);
    void fs.utimes(file, new Date(), new Date()).catch(() => undefined); // keep recent clips alive
    return data;
  } catch {
    return null;
  }
}

async function write(file: string, data: Buffer): Promise<void> {
  try {
    await fs.mkdir(DIR, { recursive: true });
    await fs.writeFile(file, data);
    await prune();
  } catch (err) {
    console.warn("Couldn't cache speech", err);
  }
}

/** Keeps the folder from growing forever: oldest-used files go first. */
async function prune(): Promise<void> {
  const names = await fs.readdir(DIR).catch(() => []);
  if (names.length <= MAX_FILES) return;
  const stats = await Promise.all(
    names.map(async (name) => {
      const file = path.join(DIR, name);
      const info = await fs.stat(file).catch(() => null);
      return info ? { file, used: info.mtimeMs } : null;
    }),
  );
  const oldest = stats.filter((s): s is { file: string; used: number } => s !== null).sort((a, b) => a.used - b.used);
  await Promise.all(oldest.slice(0, oldest.length - MAX_FILES).map((s) => fs.unlink(s.file).catch(() => undefined)));
}

/** Her voice for these words, from the cache when we've said them before. */
export async function speech(segments: SpeechSegment[], choice: VoiceChoice): Promise<Buffer> {
  const file = path.join(DIR, `${key(segments, choice)}.wav`);
  const cached = await read(file);
  if (cached) return cached;
  const wav = await synthesizeWith(segments, choice);
  await write(file, wav);
  return wav;
}

/** The lip-synced video for these words, if it has been rendered before. */
export async function cachedVideo(segments: SpeechSegment[], choice: VoiceChoice & { face: string }): Promise<Buffer | null> {
  return read(path.join(DIR, `${key(segments, choice)}-${choice.face}.mp4`));
}

export async function cacheVideo(segments: SpeechSegment[], choice: VoiceChoice & { face: string }, video: Buffer): Promise<void> {
  await write(path.join(DIR, `${key(segments, choice)}-${choice.face}.mp4`), video);
}
