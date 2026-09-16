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

/** "almost" means the only difference is accents — worth pointing out, not worth failing. */
export function checkAnswer(input: string, answers: string[]): AnswerResult {
  const given = tidy(input);
  if (!given) return "wrong";
  const expected = answers.map(tidy);
  if (expected.includes(given)) return "correct";
  if (expected.some((a) => withoutAccents(a) === withoutAccents(given))) return "almost";
  return "wrong";
}
