"use client";

import { useState } from "react";
import { checkAnswer, type AnswerResult } from "@/lib/answers";
import { CATEGORY_LABELS, type QuizQuestion } from "@/lib/types";

const RESULT_TITLES: Record<AnswerResult, string> = {
  correct: "Correct !",
  almost: "Almost: check the accents",
  wrong: "Not quite",
};

interface Props {
  questions: QuizQuestion[];
  /** Reads the answer aloud. Left out where the page has no voice, and then the button is hidden. */
  listen?: (text: string) => void;
  /** Offered on the score screen; leave out to end the quiz there. */
  onNew?: () => void;
  newLabel?: string;
  busy?: boolean;
  /** Extra buttons on the score screen, e.g. a link back to the deck. */
  footer?: React.ReactNode;
}

/** Runs one written quiz: a question at a time, then the score. Used on Practice and Progress. */
export function QuizPlayer({ questions, listen, onNew, newLabel = "New quiz", busy, footer }: Props) {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [score, setScore] = useState(0);

  const resetQuestion = () => {
    setAnswer("");
    setPicked(null);
    setResult(null);
  };

  if (index >= questions.length) {
    return (
      <div className="panel empty">
        <h2>
          Score: {score} / {questions.length}
        </h2>
        <p className="muted">{score === questions.length ? "Parfait !" : "The ones you missed are good material for your next session."}</p>
        <div className="row">
          {onNew && (
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => {
                setIndex(0);
                setScore(0);
                resetQuestion();
                onNew();
              }}
            >
              {busy ? "Writing your quiz…" : newLabel}
            </button>
          )}
          {footer}
        </div>
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
            {listen && (
              <button className="link" onClick={() => listen(q.answer)}>
                Listen
              </button>
            )}
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
