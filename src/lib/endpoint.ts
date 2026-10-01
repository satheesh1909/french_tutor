/**
 * How long to wait for more speech, judged from what has been said so far.
 *
 * A fixed pause can only be wrong in one direction at a time. Set short, it sends half a thought the
 * moment the student hesitates over a word; set long, every finished answer is followed by a wait
 * that serves no one. The way out is to read the words: "tu es allé où ?" is finished and needs no
 * grace at all, while "je suis allé à, euh..." plainly is not.
 *
 * Deliberately lopsided. Waiting too long is a mild annoyance; cutting someone off mid-sentence
 * loses what they said and makes them repeat it, so shortening needs real evidence of a finished
 * sentence and anything unclear leaves the student's own setting alone.
 */

/** Words that cannot end a sentence: the thought continues after them. */
const DANGLING = new Set([
  // hesitation
  "euh", "euuh", "hum", "heu", "ben", "bah", "um", "uh", "er", "erm",
  // conjunctions and prepositions
  "et", "ou", "mais", "donc", "car", "ni", "or", "puis", "parce", "que", "qu", "quand", "si", "comme",
  "à", "a", "au", "aux", "de", "du", "des", "dans", "en", "sur", "sous", "avec", "sans", "pour", "par",
  "chez", "vers", "entre", "pendant", "depuis", "avant", "après", "contre",
  // determiners and pronouns that must be followed by something
  "le", "la", "les", "un", "une", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses",
  "notre", "nos", "votre", "vos", "leur", "leurs", "ce", "cet", "cette", "ces", "qui", "dont",
  "je", "j", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
  // the commonest auxiliaries and copulas, which need a complement
  "est", "sont", "suis", "es", "ai", "as", "avons", "avez", "ont", "c'est", "très", "plus", "moins",
  // English equivalents, for the asides
  "and", "or", "but", "so", "because", "the", "a", "an", "my", "your", "to", "of", "in", "with", "is", "are", "very",
]);

export interface EndpointAdvice {
  waitMs: number;
  /** Why, for the status line and for arguing with later. */
  reason: "finished" | "unfinished" | "unclear";
}

/** Waits for a finished sentence, and for one still being assembled. Both within the student's range. */
export const ENDPOINT_WAIT = { finished: 550, unfinished: 1_500 };

/**
 * `heardSoFar` is everything transcribed from this turn. `chosen` is the student's own pause setting,
 * which is the fallback and also the ceiling on impatience: someone who asked for a long pause gets
 * one, and the short wait is never longer than what they asked for.
 */
export function endpointFor(heardSoFar: string, chosen: number): EndpointAdvice {
  const text = heardSoFar.trim();
  if (!text) return { waitMs: chosen, reason: "unclear" };

  // Whisper punctuates, and a question or a full stop is the clearest signal a sentence closed.
  if (/[.!?]["»']?$/.test(text)) return { waitMs: Math.min(chosen, ENDPOINT_WAIT.finished), reason: "finished" };

  const last = (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).at(-1) ?? "";
  // A trailing comma is a list or a clause boundary: more is coming.
  if (text.endsWith(",") || DANGLING.has(last)) {
    return { waitMs: Math.max(chosen, ENDPOINT_WAIT.unfinished), reason: "unfinished" };
  }
  return { waitMs: chosen, reason: "unclear" };
}
