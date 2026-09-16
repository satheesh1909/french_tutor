import { newCard } from "./srs";
import { cosine, embed } from "./ollama";
import { readCards, readEmbeddings, readMistakes, withLock, writeCards, writeEmbeddings, writeMistakes } from "./store";
import { CATEGORY_LABELS, type Correction, type MistakeRecord, type VocabItem } from "./types";

// Similarity thresholds for nomic-embed-text vectors. "Same" merges repeats of one mistake
// (e.g. "à le marché" and "à le cinéma"); "related" surfaces past mistakes worth reminding about.
const SAME_MISTAKE = 0.93;
const RELATED_MISTAKE = 0.7;

const tidy = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
const describe = (m: Pick<Correction, "original" | "corrected" | "category">) =>
  `${m.original} → ${m.corrected} (${CATEGORY_LABELS[m.category]})`;

function findSameMistake(
  c: Correction,
  vector: number[] | null,
  mistakes: MistakeRecord[],
  vectors: Record<string, number[]>,
): MistakeRecord | undefined {
  const exact = mistakes.find((m) => tidy(m.original) === tidy(c.original) && tidy(m.corrected) === tidy(c.corrected));
  if (exact || !vector) return exact;
  let best: MistakeRecord | undefined;
  let bestScore = SAME_MISTAKE;
  for (const m of mistakes) {
    if (m.category !== c.category || !vectors[m.id]) continue;
    const score = cosine(vector, vectors[m.id]);
    if (score >= bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

/** Logs corrections to the mistake history and creates a review card for each new mistake. */
export async function recordCorrections(sessionId: string, corrections: Correction[]): Promise<void> {
  if (corrections.length === 0) return;
  const vectors = await embed(corrections.map(describe), "document");

  await withLock(async () => {
    const [mistakes, stored, cards] = await Promise.all([readMistakes(), readEmbeddings(), readCards()]);
    const now = new Date().toISOString();

    corrections.forEach((c, i) => {
      const vector = vectors?.[i] ?? null;
      const existing = findSameMistake(c, vector, mistakes, stored);
      if (existing) {
        existing.count += 1;
        existing.lastSeen = now;
        if (!existing.sessionIds.includes(sessionId)) existing.sessionIds.push(sessionId);
        // A mistake that comes back should come back for review too, even if its card was scheduled far out.
        const card = cards.find((k) => k.mistakeId === existing.id);
        if (card && card.due > now) card.due = now;
        return;
      }
      const record: MistakeRecord = {
        id: crypto.randomUUID(),
        category: c.category,
        original: c.original,
        corrected: c.corrected,
        explanation: c.explanation,
        severity: c.severity,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        sessionIds: [sessionId],
      };
      mistakes.push(record);
      if (vector) stored[record.id] = vector;
      cards.push(
        newCard({ kind: "correction", mistakeId: record.id, prompt: c.original, answer: c.corrected, note: c.explanation, category: c.category }),
      );
    });

    await Promise.all([writeMistakes(mistakes), writeEmbeddings(stored), writeCards(cards)]);
  });
}

export async function recordVocabulary(items: VocabItem[]): Promise<void> {
  if (items.length === 0) return;
  await withLock(async () => {
    const cards = await readCards();
    const known = new Set(cards.filter((c) => c.kind === "vocab").map((c) => tidy(c.answer)));
    for (const item of items) {
      if (known.has(tidy(item.french))) continue;
      known.add(tidy(item.french));
      cards.push(newCard({ kind: "vocab", mistakeId: null, prompt: item.english, answer: item.french, note: item.example, category: null }));
    }
    await writeCards(cards);
  });
}

export interface RecalledMistakes {
  recurring: MistakeRecord[];
  related: MistakeRecord[];
}

/** Picks past mistakes worth the tutor's attention this turn: frequent ones, plus ones similar to what was just said. */
export async function recallMistakes(studentText: string | null): Promise<RecalledMistakes> {
  const mistakes = await readMistakes();
  const recurring = mistakes
    .filter((m) => m.count >= 2)
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 5);
  if (!studentText || mistakes.length === 0) return { recurring, related: [] };

  const [query] = (await embed([studentText], "query")) ?? [];
  if (!query) return { recurring, related: [] };
  const stored = await readEmbeddings();
  const skip = new Set(recurring.map((m) => m.id));
  const related = mistakes
    .filter((m) => !skip.has(m.id) && stored[m.id])
    .map((m) => ({ m, score: cosine(query, stored[m.id]) }))
    .filter((x) => x.score >= RELATED_MISTAKE)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.m);
  return { recurring, related };
}
