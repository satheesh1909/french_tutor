// Speaking-speed measures. Used on the server (from Whisper word timings) and in the browser
// (from the loudness of the recording), so no Node imports here.

/** A silence at least this long between words counts as a pause (a common threshold in L2 fluency research). */
export const PAUSE_SECONDS = 0.4;

export interface SpeechTiming {
  durationSec: number;
  startSec: number;
  endSec: number;
  pausesSec: number[];
}

export interface WordTiming {
  start: number;
  end: number;
}

export interface FluencyStats {
  source: "whisper" | "recording";
  words: number;
  /** From the first word to the last. */
  speakingSec: number;
  /** Speaking time minus pauses. */
  articulationSec: number;
  /** Words per minute, pauses included. */
  wpm: number;
  /** Words per minute while actually talking. */
  articulationWpm: number;
  pauses: number;
  longestPauseSec: number;
  /** Very short answers ("oui") give meaningless rates, so they're left out of averages. */
  reliable: boolean;
}

export interface FluencyAverage {
  turns: number;
  wpm: number;
  articulationWpm: number;
  pausesPerMinute: number;
}

/** Rough conversational pace by level. Individuals vary a lot; treat it as a guide, not a target. */
export const PACE_GUIDE: { level: string; range: string }[] = [
  { level: "A2", range: "60–90" },
  { level: "B1", range: "90–120" },
  { level: "B2", range: "110–140" },
  { level: "Native", range: "150+" },
];

export const countWords = (text: string) => (text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length;

const round1 = (n: number) => Math.round(n * 10) / 10;

function build(source: FluencyStats["source"], words: number, speakingSec: number, pauses: number[]): FluencyStats {
  const paused = pauses.reduce((sum, p) => sum + p, 0);
  const articulationSec = Math.max(speakingSec - paused, 0.1);
  return {
    source,
    words,
    speakingSec: round1(speakingSec),
    articulationSec: round1(articulationSec),
    wpm: speakingSec > 0 ? Math.round((words / speakingSec) * 60) : 0,
    articulationWpm: Math.round((words / articulationSec) * 60),
    pauses: pauses.length,
    longestPauseSec: round1(pauses.length ? Math.max(...pauses) : 0),
    reliable: words >= 4 && speakingSec >= 1.5,
  };
}

export function fluencyFromWords(text: string, timings: WordTiming[]): FluencyStats | null {
  if (timings.length === 0) return null;
  const pauses: number[] = [];
  for (let i = 1; i < timings.length; i++) {
    const gap = timings[i].start - timings[i - 1].end;
    if (gap >= PAUSE_SECONDS) pauses.push(gap);
  }
  return build("whisper", countWords(text), timings[timings.length - 1].end - timings[0].start, pauses);
}

export function fluencyFromTiming(text: string, timing: SpeechTiming): FluencyStats | null {
  if (timing.endSec <= timing.startSec) return null;
  return build("recording", countWords(text), timing.endSec - timing.startSec, timing.pausesSec.filter((p) => p >= PAUSE_SECONDS));
}

/** Time-weighted, so a long answer counts more than a short one. */
export function averageFluency(stats: FluencyStats[]): FluencyAverage | null {
  const usable = stats.filter((s) => s.reliable);
  if (usable.length === 0) return null;
  const words = usable.reduce((n, s) => n + s.words, 0);
  const speaking = usable.reduce((n, s) => n + s.speakingSec, 0);
  const articulation = usable.reduce((n, s) => n + s.articulationSec, 0);
  const pauses = usable.reduce((n, s) => n + s.pauses, 0);
  return {
    turns: usable.length,
    wpm: Math.round((words / speaking) * 60),
    articulationWpm: Math.round((words / articulation) * 60),
    pausesPerMinute: round1((pauses / speaking) * 60),
  };
}

const finite = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;

/** Checks numbers that arrive from the browser before they're stored. */
export function sanitizeFluency(input: unknown): FluencyStats | undefined {
  const f = input as Partial<FluencyStats> | null;
  if (!f || (f.source !== "whisper" && f.source !== "recording")) return undefined;
  const numbers: [unknown, number][] = [
    [f.words, 5000],
    [f.speakingSec, 3600],
    [f.articulationSec, 3600],
    [f.wpm, 1000],
    [f.articulationWpm, 1000],
    [f.pauses, 1000],
    [f.longestPauseSec, 3600],
  ];
  if (!numbers.every(([v, max]) => finite(v, max))) return undefined;
  return {
    source: f.source,
    words: f.words!,
    speakingSec: f.speakingSec!,
    articulationSec: f.articulationSec!,
    wpm: f.wpm!,
    articulationWpm: f.articulationWpm!,
    pauses: f.pauses!,
    longestPauseSec: f.longestPauseSec!,
    reliable: f.reliable === true,
  };
}

export function parseSpeechTiming(raw: string | null): SpeechTiming | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as Partial<SpeechTiming>;
    if (!finite(t.durationSec, 3600) || !finite(t.startSec, 3600) || !finite(t.endSec, 3600) || !Array.isArray(t.pausesSec)) return null;
    const pausesSec = t.pausesSec.filter((p): p is number => finite(p, 3600)).slice(0, 1000);
    return { durationSec: t.durationSec, startSec: t.startSec, endSec: t.endSec, pausesSec };
  } catch {
    return null;
  }
}
