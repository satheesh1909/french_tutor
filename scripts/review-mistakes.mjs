/**
 * Lists mistakes in the history that look like they were never real errors, and removes the ones
 * you name. Nothing is deleted without an explicit id.
 *
 * The tutor used to write corrections straight into the history, so a mis-heard place name or a
 * correction that contradicted its own explanation became a flashcard and was drilled for weeks.
 * New sessions can't do that any more (the end-of-session review rules on each correction first),
 * but entries written before that change are still in the deck. This is how they come out.
 *
 *   node scripts/review-mistakes.mjs                  # list the suspects, change nothing
 *   node scripts/review-mistakes.mjs --all            # list every mistake, with its id
 *   node scripts/review-mistakes.mjs --drop <id>...   # remove those, and their cards
 *
 * A removal also takes out the matching review card and embedding, and writes a one-off backup of
 * all three files beside them first.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILES = {
  mistakes: path.join(DIR, "mistakes.json"),
  cards: path.join(DIR, "cards.json"),
  embeddings: path.join(DIR, "mistake-embeddings.json"),
};

const read = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
};

/**
 * Why an entry looks wrong. These are hints for a human, not a classifier: the point is to put the
 * doubtful ones in front of you, so deciding stays your job.
 */
function suspicions(m) {
  const reasons = [];
  const original = m.original ?? "";
  const corrected = m.corrected ?? "";
  const explanation = m.explanation ?? "";

  // The tutor talking itself out of its own correction. This one is nearly always right.
  if (/\b(is|was) (actually )?(correct|fine|acceptable|already right)\b/i.test(explanation)) {
    reasons.push("its explanation says the original was already correct");
  }

  /**
   * Capitalised words that look like names. A capital at the very start of a fragment is just a
   * sentence, and an elided form like "J'ai" or "C'est" is not a name, so both are ignored -
   * without that, almost every entry looks like a mis-heard name.
   */
  const names = (text) => {
    const tokens = text.split(/\s+/).filter(Boolean);
    const found = new Set();
    tokens.forEach((token, i) => {
      const word = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (i === 0 || word.length < 3 || word.includes("'") || word.includes("\u2019")) return;
      if (/^\p{Lu}/u.test(word)) found.add(word.toLowerCase());
    });
    return found;
  };
  const before = names(original);
  const after = names(corrected);
  const changed = [...new Set([...before].filter((w) => !after.has(w)).concat([...after].filter((w) => !before.has(w))))];
  if (changed.length) {
    reasons.push(`a name changed (${changed.join(", ")}) - often speech recognition rather than an error`);
  }

  // A "correction" that keeps almost nothing of a sentence long enough to have substance is the
  // tutor rewriting what it guessed was meant. Short fragments are excluded: changing one word of
  // three is what an ordinary correction looks like.
  const words = (t) => t.toLowerCase().replace(/[^\p{L}\s']/gu, "").split(/\s+/).filter(Boolean);
  const from = words(original);
  const to = words(corrected);
  if (from.length >= 5) {
    const kept = from.filter((w) => to.includes(w)).length;
    const ratio = kept / from.length;
    if (ratio < 0.25) {
      reasons.push(`keeps only ${Math.round(ratio * 100)}% of a ${from.length}-word original - likely a guess at what was meant`);
    }
  }
  return reasons;
}

async function main() {
  const args = process.argv.slice(2);
  const mistakes = await read(FILES.mistakes, []);
  if (!Array.isArray(mistakes) || mistakes.length === 0) {
    console.log(`No mistakes in ${FILES.mistakes}.`);
    return;
  }

  const dropAt = args.indexOf("--drop");
  if (dropAt !== -1) {
    const ids = new Set(args.slice(dropAt + 1).filter((a) => !a.startsWith("--")));
    if (ids.size === 0) return console.error("--drop needs at least one id.");

    const going = mistakes.filter((m) => ids.has(m.id));
    if (going.length === 0) return console.error("None of those ids are in the history.");

    const [cards, embeddings] = await Promise.all([read(FILES.cards, []), read(FILES.embeddings, {})]);
    const stamp = Date.now();
    for (const [name, file] of Object.entries(FILES)) {
      await fs.copyFile(file, `${file}.before-cleanup-${stamp}`).catch(() => console.warn(`  (no ${name} file to back up)`));
    }

    const keptMistakes = mistakes.filter((m) => !ids.has(m.id));
    const keptCards = Array.isArray(cards) ? cards.filter((c) => !ids.has(c.mistakeId)) : cards;
    const keptEmbeddings = Object.fromEntries(Object.entries(embeddings ?? {}).filter(([id]) => !ids.has(id)));

    await fs.writeFile(FILES.mistakes, JSON.stringify(keptMistakes, null, 2));
    await fs.writeFile(FILES.cards, JSON.stringify(keptCards, null, 2));
    await fs.writeFile(FILES.embeddings, JSON.stringify(keptEmbeddings, null, 2));

    for (const m of going) console.log(`  removed  ${m.original}  ->  ${m.corrected}`);
    console.log(
      `\n${going.length} mistake(s), ${(Array.isArray(cards) ? cards.length : 0) - (Array.isArray(keptCards) ? keptCards.length : 0)} card(s) removed.` +
        `\nBackups written as *.before-cleanup-${stamp}.`,
    );
    return;
  }

  const showAll = args.includes("--all");
  const rows = mistakes
    .map((m) => ({ m, reasons: suspicions(m) }))
    .filter((r) => showAll || r.reasons.length > 0);

  if (rows.length === 0) {
    console.log("Nothing looks suspect.");
    return;
  }

  for (const { m, reasons } of rows) {
    console.log(`\n${m.id}`);
    console.log(`  "${m.original}"  ->  "${m.corrected}"`);
    console.log(`  ${m.category}, ${m.severity}, seen ${m.count}x`);
    if (m.explanation) console.log(`  ${m.explanation}`);
    for (const reason of reasons) console.log(`  ! ${reason}`);
  }
  console.log(`\n${rows.length} of ${mistakes.length} shown. Remove some with:`);
  console.log(`  node scripts/review-mistakes.mjs --drop ${rows[0].m.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
