import type { SpeechSegment } from "./types";

/**
 * Reads finished speech segments out of a reply that is still being written.
 *
 * The tutor's answer is one JSON object, and her voice can't start until a whole sentence of it
 * exists. Waiting for the object to close cost seconds, so the model's output is scanned as it
 * arrives and each segment is handed over the moment its closing brace lands.
 *
 * It is deliberately forgiving. Anything it doesn't recognise makes it stop looking rather than
 * throw, because the finished answer is parsed properly by the provider afterwards and is the one
 * that counts: this only ever makes her start sooner, and can never be the reason a turn fails.
 */
export function speechSoFar(onSegment: (segment: SpeechSegment) => void): (delta: string) => void {
  let buffer = "";
  let cursor = -1; // until the speech array turns up, there is nothing to scan
  let finished = false;

  return (delta: string) => {
    buffer += delta;
    if (finished) return;

    if (cursor < 0) {
      const opening = /"speech"\s*:\s*\[/.exec(buffer);
      if (!opening) return;
      cursor = opening.index + opening[0].length;
    }

    for (;;) {
      while (cursor < buffer.length && (buffer[cursor] === "," || /\s/.test(buffer[cursor]))) cursor++;
      if (cursor >= buffer.length) return; // more to come
      if (buffer[cursor] !== "{") {
        finished = true; // the array has closed, or this isn't the shape we expected
        return;
      }
      const end = endOfObject(buffer, cursor);
      if (end < 0) return; // this segment is still being written
      const text = buffer.slice(cursor, end + 1);
      cursor = end + 1;
      try {
        const parsed = JSON.parse(text) as { lang?: unknown; text?: unknown };
        if ((parsed.lang === "fr" || parsed.lang === "en") && typeof parsed.text === "string" && parsed.text.trim()) {
          onSegment({ lang: parsed.lang, text: parsed.text });
        }
      } catch {
        // Unreadable piece: leave it. The finished answer carries the real thing.
      }
    }
  };
}

/**
 * Where the object starting at `from` closes, or -1 if that hasn't been written yet. Counts braces,
 * skipping any inside a string - a segment's text can perfectly well contain one.
 */
function endOfObject(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return i;
  }
  return -1;
}
