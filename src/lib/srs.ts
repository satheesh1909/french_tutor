import type { ReviewCard } from "./types";

// Spaced repetition, SM-2 style (the scheme Anki grew from): cards you get right come back
// at growing intervals; cards you miss come back in ten minutes.

export const GRADES = ["again", "hard", "good", "easy"] as const;
export type Grade = (typeof GRADES)[number];

const DAY_MS = 86_400_000;

export function newCard(fields: Pick<ReviewCard, "kind" | "mistakeId" | "prompt" | "answer" | "note" | "category">): ReviewCard {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), ...fields, ease: 2.5, intervalDays: 0, reps: 0, lapses: 0, due: now, createdAt: now, lastReviewed: null };
}

export function schedule(card: ReviewCard, grade: Grade, now = new Date()): ReviewCard {
  let { ease, intervalDays, reps, lapses } = card;
  let dueMs: number;

  if (grade === "again") {
    lapses += 1;
    reps = 0;
    ease = Math.max(1.3, ease - 0.2);
    intervalDays = 0;
    dueMs = now.getTime() + 10 * 60_000;
  } else {
    if (grade === "hard") {
      ease = Math.max(1.3, ease - 0.15);
      intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
    } else if (grade === "good") {
      intervalDays = reps === 0 ? 1 : reps === 1 ? 3 : Math.max(1, Math.round(intervalDays * ease));
    } else {
      ease += 0.15;
      intervalDays = reps === 0 ? 4 : Math.max(2, Math.round(Math.max(intervalDays, 1) * ease * 1.3));
    }
    reps += 1;
    dueMs = now.getTime() + intervalDays * DAY_MS;
  }

  return { ...card, ease, intervalDays, reps, lapses, due: new Date(dueMs).toISOString(), lastReviewed: now.toISOString() };
}
