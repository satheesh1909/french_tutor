export type AnswerResult = "correct" | "almost" | "wrong";

/** Why an answer was only "almost": nothing, the accents, or a small slip of the fingers. */
export type Slip = "none" | "accents" | "spelling";

/** One run of the expected answer, marked where it differs from what was typed. */
export interface Mark {
  text: string;
  changed: boolean;
}

export interface AnswerCheck {
  result: AnswerResult;
  /** Whichever acceptable answer came closest - what to show back, so "tu" isn't answered with "vous". */
  matched: string;
  slip: Slip;
  /** `matched`, cut into runs so the page can point at what was missing or different. */
  marks: Mark[];
}

function tidy(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[«»"“”.,!?;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const withoutAccents = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "");

/**
 * A stored answer often carries its own alternatives, written the way a dictionary would:
 * "enchanté/enchantée", "le développeur / la développeuse". Both halves are right, so both are
 * accepted - before this, only the whole string, slash included, would pass.
 */
function alternatives(answers: string[]): string[] {
  return answers.flatMap((a) => (a.includes("/") ? [a, ...a.split("/")] : [a])).filter((a) => a.trim());
}

/**
 * How many letters may be wrong before it stops being a slip and starts being a different word.
 * Short answers get no allowance at all: in French one letter is routinely the whole point - le
 * and la, ou and où, du and dû - and forgiving that would teach the opposite of what the card is for.
 */
function allowance(expected: string): number {
  const letters = expected.replace(/\s/g, "").length;
  if (letters < 6) return 0;
  return letters < 14 ? 1 : 2;
}

/**
 * Edit distance counting a swapped pair as one mistake, not two. Typing "veins" for "viens" is the
 * commonest slip there is, and plain Levenshtein scores it the same as two unrelated wrong letters.
 */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let twoBack: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], twoBack[j - 2] + 1);
      }
    }
    [twoBack, prev] = [prev, row];
  }
  return prev[b.length];
}

/**
 * Which parts of the expected answer the student didn't type, found with a longest-common-
 * subsequence walk. Comparing the displayed strings rather than the tidied ones keeps the marks
 * lined up with the letters actually shown.
 */
function marksFor(matched: string, given: string): Mark[] {
  const a = [...matched];
  const b = [...withoutAccents(given).toLowerCase()];
  const same = (x: string, y: string) => withoutAccents(x).toLowerCase() === y;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const marks: Mark[] = [];
  const push = (text: string, changed: boolean) => {
    const last = marks.at(-1);
    if (last && last.changed === changed) last.text += text;
    else marks.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length) {
    if (j < b.length && same(a[i], b[j])) push(a[i++], false), j++;
    else if (j < b.length && dp[i + 1][j] < dp[i][j + 1]) j++;
    else push(a[i++], true);
  }
  return marks;
}

/**
 * Grades an answer and says what was different about it.
 *
 * "almost" is a pass that gets pointed at rather than waved through: the accents were wrong, or a
 * letter was. It suggests the "Hard" grade, so the card comes back sooner than one answered cleanly
 * - which is the safety net under this leniency, because the rule cannot tell a finger that slipped
 * off the s from a student who doesn't know the s belongs there.
 */
export function gradeAnswer(input: string, answers: string[]): AnswerCheck {
  const given = tidy(input);
  const options = alternatives(answers);
  const fallback = options[0] ?? "";
  if (!given) return { result: "wrong", matched: fallback, slip: "none", marks: [{ text: fallback, changed: true }] };

  const exact = options.find((a) => tidy(a) === given);
  if (exact) return { result: "correct", matched: exact, slip: "none", marks: [{ text: exact, changed: false }] };

  const accented = options.find((a) => withoutAccents(tidy(a)) === withoutAccents(given));
  if (accented) return { result: "almost", matched: accented, slip: "accents", marks: marksFor(accented, input.trim()) };

  // The closest remaining answer, and whether it is close enough to be a slip rather than a miss.
  let best = fallback;
  let bestGap = Infinity;
  for (const option of options) {
    const gap = distance(withoutAccents(tidy(option)), withoutAccents(given));
    if (gap < bestGap) [best, bestGap] = [option, gap];
  }
  const result: AnswerResult = bestGap <= allowance(tidy(best)) ? "almost" : "wrong";
  return { result, matched: best, slip: result === "almost" ? "spelling" : "none", marks: marksFor(best, input.trim()) };
}

/** The verdict alone, for callers that don't show the difference. */
export const checkAnswer = (input: string, answers: string[]): AnswerResult => gradeAnswer(input, answers).result;
