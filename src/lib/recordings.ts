import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { FluencyStats } from "./fluency";
import type { HeardLanguage } from "./types";

/**
 * Keeps the last few recordings on disk, with what was made of them.
 *
 * Until now a recording was transcribed and thrown away, so a turn that came back as something you
 * never said could only be reasoned about, never re-examined: two of them were transcribed into
 * Persian and Hindi and the audio was already gone. With the clip kept, the same seconds of speech
 * can be run through another model and the two answers put side by side - which is the only honest
 * way to tell whether a change to the transcription actually helped.
 *
 * This is speech, so it stays on this machine, it stays small, and the oldest goes first.
 */

const DIR = path.join(config.dataDir, "recordings");

export interface RecordingNote {
  text: string;
  heard: HeardLanguage | null;
  fluency: FluencyStats | null;
  engine: string;
  model: string;
}

/** Fire-and-forget: keeping a copy must never cost the student their turn. */
export function keepRecording(wav: Buffer, note: RecordingNote): void {
  if (config.keepRecordings <= 0) return;
  void save(wav, note).catch((err) => console.warn("Couldn't keep that recording", err));
}

async function save(wav: Buffer, note: RecordingNote): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  // Sortable by name, so pruning is just "drop the ones at the front".
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  await fs.writeFile(path.join(DIR, `${stem}.wav`), wav);
  await fs.writeFile(path.join(DIR, `${stem}.json`), JSON.stringify({ at: new Date().toISOString(), ...note }, null, 2));
  await prune();
}

/** Keeps the newest few clips and their notes; everything older goes. */
async function prune(): Promise<void> {
  const names = await fs.readdir(DIR).catch(() => []);
  const stems = [...new Set(names.filter((n) => n.endsWith(".wav")).map((n) => n.slice(0, -4)))].sort();
  for (const stem of stems.slice(0, Math.max(0, stems.length - config.keepRecordings))) {
    await fs.rm(path.join(DIR, `${stem}.wav`), { force: true });
    await fs.rm(path.join(DIR, `${stem}.json`), { force: true });
  }
}
