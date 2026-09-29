export type AnswerResult = "correct" | "almost" | "wrong";

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
 * "enchante/enchantee", "le developpeur / la developpeuse". Both halves are right, so both are
 * accepted - before this, only the whole string, slash included, would pass.
 */
function alternatives(answers: string[]): string[] {
  return answers.flatMap((a) => (a.includes("/") ? [a, ...a.split("/")] : [a]));
}

/** "almost" means the only difference is accents — worth pointing out, not worth failing. */
export function checkAnswer(input: string, answers: string[]): AnswerResult {
  const given = tidy(input);
  if (!given) return "wrong";
  const expected = alternatives(answers).map(tidy).filter(Boolean);
  if (expected.includes(given)) return "correct";
  if (expected.some((a) => withoutAccents(a) === withoutAccents(given))) return "almost";
  return "wrong";
}
