"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { checkAnswer, type AnswerResult } from "@/lib/answers";
import type { Grade } from "@/lib/srs";
import { CATEGORY_LABELS, type LearnerProfile, type QuizQuestion, type ReviewCard, type VoiceProvider } from "@/lib/types";
import { api, errorMessage } from "./api";
import { formatWhen } from "./format";
import { speak } from "./voice";

const RESULT_TITLES: Record<AnswerResult, string> = {
  correct: "Correct !",
  almost: "Almost: check the accents",
  wrong: "Not quite",
};

export function PracticeApp() {
  const [tab, setTab] = useState<"review" | "quiz">("review");
  const [voice, setVoice] = useState<VoiceProvider>("gemini");
  const playing = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .get<{ profile: LearnerProfile }>("/api/profile")
      .then((r) => setVoice(r.profile.voice))
      .catch(() => undefined);
  }, []);

  const listen = useCallback(
    (text: string) => {
      playing.current?.abort();
      const controller = new AbortController();
      playing.current = controller;
      speak([{ lang: "fr", text }], voice, { current: 0 }, controller.signal).catch(() => undefined);
    },
    [voice],
  );

  return (
    <div className="practice">
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
          Review cards
        </button>
        <button className="tab" role="tab" aria-selected={tab === "quiz"} onClick={() => setTab("quiz")}>
          Quiz
        </button>
      </div>
      {tab === "review" ? <ReviewDeck listen={listen} /> : <QuizRunner listen={listen} />}
    </div>
  );
}

interface DueCards {
  due: ReviewCard[];
  dueCount: number;
  total: number;
  nextDue: string | null;
}

const GRADE_BUTTONS: { grade: Grade; label: string; hint: string }[] = [
  { grade: "again", label: "Again", hint: "Didn't know it" },
  { grade: "hard", label: "Hard", hint: "Got there slowly" },
  { grade: "good", label: "Good", hint: "Knew it" },
  { grade: "easy", label: "Easy", hint: "Too easy" },
];

function ReviewDeck({ listen }: { listen: (text: string) => void }) {
  const [deck, setDeck] = useState<DueCards | null>(null);
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<DueCards>("/api/practice")
      .then((d) => {
        setDeck(d);
        setQueue(d.due);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const card = queue[0];

  const check = () => {
    if (card && answer.trim()) setResult(checkAnswer(answer, [card.answer]));
  };

  const grade = async (g: Grade) => {
    if (!card) return;
    setSaving(true);
    try {
      const { card: updated } = await api.post<{ card: ReviewCard }>("/api/practice", { cardId: card.id, grade: g });
      // Missed cards come round again at the end of this sitting.
      setQueue((q) => (g === "again" ? [...q.slice(1), updated] : q.slice(1)));
      setReviewed((n) => n + 1);
      setAnswer("");
      setResult(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="alert">{error}</div>;
  if (!deck) return <p className="muted">Loading your cards…</p>;

  if (!card) {
    return (
      <div className="panel empty">
        <h2>{reviewed > 0 ? "All done for now. Bravo !" : "Nothing to review right now"}</h2>
        <p className="muted">
          {deck.total === 0
            ? "Cards are created automatically from your corrections and new vocabulary during sessions."
            : `You have ${deck.total} card${deck.total === 1 ? "" : "s"}.${deck.nextDue ? ` The next one is due ${formatWhen(deck.nextDue)}.` : ""}`}
        </p>
        {reviewed > 0 && (
          <button className="btn" onClick={load}>
            Check again
          </button>
        )}
      </div>
    );
  }

  const suggested: Grade = result === "wrong" ? "again" : result === "almost" ? "hard" : "good";

  return (
    <div className="panel flash" key={`${card.id}-${card.lastReviewed}`}>
      <div className="flash__top">
        <span className="eyebrow">{card.kind === "correction" ? "Fix the mistake" : "Say it in French"}</span>
        <span className="muted small">{queue.length} left</span>
      </div>
      <p className="flash__prompt" lang={card.kind === "correction" ? "fr" : "en"}>
        {card.kind === "correction" ? `« ${card.prompt} »` : card.prompt}
      </p>
      {card.category && <span className="chip">{CATEGORY_LABELS[card.category]}</span>}
      <input
        className="input flash__input"
        lang="fr"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && result === null) check();
        }}
        placeholder={card.kind === "correction" ? "Type the corrected version" : "Type it in French"}
        disabled={result !== null}
        autoFocus
        spellCheck={false}
        aria-label="Your answer"
      />
      {result === null ? (
        <div className="row">
          <button className="btn btn--primary" onClick={check} disabled={!answer.trim()}>
            Check
          </button>
          <button className="btn btn--ghost" onClick={() => setResult("wrong")}>
            Show answer
          </button>
        </div>
      ) : (
        <div className={`result result--${result}`}>
          <p className="result__title">{RESULT_TITLES[result]}</p>
          <p className="result__answer" lang="fr">
            {card.answer}
            <button className="link" onClick={() => listen(card.answer)}>
              Listen
            </button>
          </p>
          {card.note && <p className="small">{card.note}</p>}
          <div className="grades">
            {GRADE_BUTTONS.map((b) => (
              <button key={b.grade} className={`grade${b.grade === suggested ? " grade--suggested" : ""}`} onClick={() => void grade(b.grade)} disabled={saving}>
                <strong>{b.label}</strong>
                <span>{b.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function QuizRunner({ listen }: { listen: (text: string) => void }) {
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [score, setScore] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetQuestion = () => {
    setAnswer("");
    setPicked(null);
    setResult(null);
  };

  const create = async () => {
    setLoading(true);
    setError(null);
    try {
      const { questions: fresh } = await api.post<{ questions: QuizQuestion[] }>("/api/quiz", { count: 8 });
      setQuestions(fresh);
      setIndex(0);
      setScore(0);
      resetQuestion();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  if (!questions || questions.length === 0) {
    return (
      <div className="panel empty">
        <h2>Written quiz</h2>
        <p className="muted">
          Gemini writes a fresh quiz from your most frequent mistakes and newest vocabulary. Until you have some history, it covers core A2 → B1 grammar.
        </p>
        {questions?.length === 0 && <p className="small">No usable questions came back. Try again.</p>}
        {error && <div className="alert">{error}</div>}
        <button className="btn btn--primary" onClick={() => void create()} disabled={loading}>
          {loading ? "Writing your quiz…" : "Create a quiz"}
        </button>
      </div>
    );
  }

  if (index >= questions.length) {
    return (
      <div className="panel empty">
        <h2>
          Score: {score} / {questions.length}
        </h2>
        <p className="muted">{score === questions.length ? "Parfait !" : "The ones you missed are good material for your next session."}</p>
        {error && <div className="alert">{error}</div>}
        <button className="btn btn--primary" onClick={() => void create()} disabled={loading}>
          {loading ? "Writing your quiz…" : "New quiz"}
        </button>
      </div>
    );
  }

  const q = questions[index];
  const submit = (value: string) => {
    const r = checkAnswer(value, q.acceptedAnswers);
    setResult(r);
    if (r !== "wrong") setScore((s) => s + 1);
  };

  return (
    <div className="panel flash" key={q.id}>
      <div className="flash__top">
        <span className="eyebrow">
          Question {index + 1} of {questions.length}
        </span>
        <span className="muted small">Score {score}</span>
      </div>
      <p className="flash__prompt">{q.question}</p>
      <span className="chip">{CATEGORY_LABELS[q.category]}</span>

      {q.type === "multiple_choice" ? (
        <div className="options">
          {q.options.map((o) => {
            const state = result === null ? "" : o === q.answer ? " option--correct" : o === picked ? " option--wrong" : "";
            return (
              <button
                key={o}
                lang="fr"
                className={`option${state}`}
                disabled={result !== null}
                onClick={() => {
                  setPicked(o);
                  submit(o);
                }}
              >
                {o}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <input
            className="input flash__input"
            lang="fr"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && result === null && answer.trim()) submit(answer);
            }}
            placeholder={q.type === "translate" ? "Écris la traduction" : "The missing word(s)"}
            disabled={result !== null}
            autoFocus
            spellCheck={false}
            aria-label="Your answer"
          />
          {result === null && (
            <div className="row">
              <button className="btn btn--primary" onClick={() => submit(answer)} disabled={!answer.trim()}>
                Check
              </button>
              <button className="btn btn--ghost" onClick={() => setResult("wrong")}>
                Show answer
              </button>
            </div>
          )}
        </>
      )}

      {result !== null && (
        <div className={`result result--${result}`}>
          <p className="result__title">{RESULT_TITLES[result]}</p>
          <p className="result__answer" lang="fr">
            {q.answer}
            <button className="link" onClick={() => listen(q.answer)}>
              Listen
            </button>
          </p>
          <p className="small">{q.explanation}</p>
          <div className="row">
            <button
              className="btn btn--primary"
              onClick={() => {
                setIndex((i) => i + 1);
                resetQuestion();
              }}
            >
              {index + 1 < questions.length ? "Next question" : "See score"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
