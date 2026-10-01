"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  CATEGORY_LABELS,
  CEFR_LEVELS,
  MODE_LABELS,
  ROLEPLAY_SCENARIOS,
  type AppSettings,
  type CefrLevel,
  type CoachAnswer,
  type CoachTurn,
  type ErrorCategory,
  type LearnerProfile,
  type MistakeRecord,
  type QuizQuestion,
  type SessionSummary,
  type TurnTiming,
  type VoiceSettings,
} from "@/lib/types";
import { PACE_GUIDE, type FluencyAverage } from "@/lib/fluency";
import { api, errorMessage } from "./api";
import { QuizPlayer } from "./QuizPlayer";
import { speak } from "./voice";
import { formatDate } from "./format";

interface ProgressData {
  profile: LearnerProfile;
  sessions: SessionSummary[];
  categories: { category: ErrorCategory; count: number }[];
  topMistakes: MistakeRecord[];
  mistakeCount: number;
  cards: { total: number; due: number; mature: number };
  levelThresholds: { words: number; turns: number };
  speaking: Record<"today" | "week" | "previousWeek" | "month" | "allTime", FluencyAverage | null>;
}

/**
 * A session too small to be evidence. The same rule runs on the server when the profile is
 * written (see src/app/api/session/end/route.ts); this is only so the null result is visible
 * instead of looking like nothing happened.
 */
function isTooShort(s: SessionSummary, limits: { words: number; turns: number }): boolean {
  return s.studentWords < limits.words || s.turnCount < limits.turns;
}

export function ProgressApp() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ProgressData>("/api/progress")
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, []);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  const { profile } = data;

  return (
    <div className="progress">
      <section className="panel progress__level">
        <h2 className="section-title">Your level</h2>
        <div className="level-hero">
          <div>
            <span className="eyebrow">Now</span>
            <strong>{profile.currentLevel}</strong>
          </div>
          <span className="level-hero__arrow" aria-hidden="true">
            →
          </span>
          <div>
            <span className="eyebrow">Next goal</span>
            <strong>{profile.targetLevel}</strong>
          </div>
        </div>
        {profile.levels ? (
          <div className="levels">
            {(["speaking", "grammar", "vocabulary"] as const).map((k) => (
              <div key={k} className="level">
                <span>{k}</span>
                <strong>{profile.levels?.[k]}</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Finish a session to get level estimates. A Level check session is a good first step.</p>
        )}
        {profile.levelNotes && <p>{profile.levelNotes}</p>}
        {profile.focusAreas.length > 0 && (
          <>
            <h3 className="subhead">Focus areas</h3>
            <ul className="bullets">
              {profile.focusAreas.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        )}
        {profile.nextSessionPlan && (
          <>
            <h3 className="subhead">Plan for next session</h3>
            <p>{profile.nextSessionPlan}</p>
          </>
        )}
      </section>

      <CoachPanel reviewed={data.sessions.filter((s) => s.review).length} />

      <SpeakingPanel speaking={data.speaking} />

      <ResponsePanel />

      <section className="panel">
        <h2 className="section-title">Mistakes &amp; review</h2>
        <div className="stats">
          <Stat label="Mistakes logged" value={data.mistakeCount} />
          <Stat label="Review cards" value={data.cards.total} />
          <Stat label="Due now" value={data.cards.due} />
          <Stat label="Well learned" value={data.cards.mature} />
        </div>
        {data.categories.length === 0 ? (
          <p className="muted">No mistakes logged yet.</p>
        ) : (
          <>
            <h3 className="subhead">By type</h3>
            <ol className="ranked">
              {data.categories.map((c) => (
                <li key={c.category}>
                  <span>{CATEGORY_LABELS[c.category]}</span>
                  <span className="count">{c.count}</span>
                </li>
              ))}
            </ol>
            <h3 className="subhead">Most repeated</h3>
            <ul className="corrections">
              {data.topMistakes.map((m) => (
                <li key={m.id} className={`correction correction--${m.severity}`}>
                  <div className="correction__pair" lang="fr">
                    <s>{m.original}</s>
                    <span aria-hidden="true">→</span>
                    <strong>{m.corrected}</strong>
                  </div>
                  <div className="correction__meta">
                    <span className="chip">{CATEGORY_LABELS[m.category]}</span>
                    <span className="muted small">×{m.count}</span>
                  </div>
                  <p className="small">{m.explanation}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">Sessions</h2>
        {data.sessions.length === 0 ? (
          <p className="muted">No sessions yet.</p>
        ) : (
          <ul className="sessions">
            {data.sessions.map((s) => {
              const scenario = ROLEPLAY_SCENARIOS.find((x) => x.id === s.scenarioId);
              const tooShort = (x: SessionSummary) => isTooShort(x, data.levelThresholds);
              return (
                <li key={s.id}>
                  <details>
                    <summary>
                      <span>{formatDate(s.startedAt)}</span>
                      <strong>
                        {MODE_LABELS[s.mode].title}
                        {scenario ? ` · ${scenario.title}` : s.topic ? ` · ${s.topic}` : ""}
                      </strong>
                      <span className="muted small">
                        {s.turnCount} turns · {s.correctionCount} corrections
                        {s.fluency ? ` · ${s.fluency.wpm} wpm` : ""}
                        {s.review && !tooShort(s) ? ` · ${s.review.levels.overall}` : ""}
                      </span>
                    </summary>
                    {s.review ? (
                      <div className="session-review">
                        {tooShort(s) && (
                          <p className="small muted">
                            Too short to judge your level: {s.studentWords} word{s.studentWords === 1 ? "" : "s"} over {s.turnCount} turn
                            {s.turnCount === 1 ? "" : "s"}, where {data.levelThresholds.words} words and {data.levelThresholds.turns} turns are
                            needed. Your level was left as it was; the advice below still stands.
                          </p>
                        )}
                        <p>{s.review.summary}</p>
                        {s.review.fluencyNote && <p className="small">{s.review.fluencyNote}</p>}
                        <ul className="bullets">
                          {s.review.focusAreas.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="muted small">No review: this session wasn&apos;t ended with &ldquo;End &amp; review&rdquo;.</p>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="section-title">Settings</h2>
        <ProfileForm profile={profile} onSaved={(p) => setData((d) => d && { ...d, profile: p })} />
      </section>
    </div>
  );
}

/** The coach is asked for plain text, but models reach for **bold** anyway, so render that much. */
function CoachText({ text }: { text: string }) {
  const parts = text.split("**");
  if (parts.length < 3 || parts.length % 2 === 0) return <>{text}</>;
  return <>{parts.map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))}</>;
}

const STARTER_QUESTIONS = [
  "Where am I really — A2 or B1?",
  "What is stopping me from reaching B1?",
  "How did my last level check go?",
  "What should I practise this week?",
  "Is my speaking speed normal for my level?",
];

/** Ask the examiner about your own level, and turn the answer into a quiz. */
function CoachPanel({ reviewed }: { reviewed: number }) {
  const [turns, setTurns] = useState<CoachTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [questions, setQuestions] = useState<QuizQuestion[] | null>(null);
  const [quizNo, setQuizNo] = useState(0);
  const [quizTopic, setQuizTopic] = useState<string | null>(null);
  const [quizBusy, setQuizBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const [voice, setVoice] = useState<VoiceSettings | null>(null);
  const playing = useRef<AbortController | null>(null);

  // Only so quiz answers can be heard, the same as on the Practice page.
  useEffect(() => {
    api
      .get<{ settings: AppSettings }>("/api/settings?options=false")
      .then((r) => setVoice(r.settings.voice))
      .catch(() => undefined);
  }, []);

  const listen = useCallback(
    (text: string) => {
      if (!voice) return;
      playing.current?.abort();
      const controller = new AbortController();
      playing.current = controller;
      speak([{ lang: "fr", text }], voice, { current: 0 }, controller.signal).catch(() => undefined);
    },
    [voice],
  );

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || asking) return;
    const history: CoachTurn[] = [...turns, { role: "student", text }];
    setTurns(history);
    setDraft("");
    setSuggested(null);
    setAsking(true);
    setError(null);
    try {
      const answer = await api.post<CoachAnswer>("/api/coach", { messages: history });
      setTurns([...history, { role: "coach", text: answer.answer }]);
      setSuggested(answer.quizTopic);
    } catch (e) {
      setError(errorMessage(e));
      setTurns(history.slice(0, -1));
      setDraft(text);
    } finally {
      setAsking(false);
    }
  };

  const makeQuiz = async (focus: string | null) => {
    setQuizBusy(true);
    setError(null);
    try {
      const { questions: fresh } = await api.post<{ questions: QuizQuestion[] }>("/api/quiz", { count: 8, topic: focus });
      setQuestions(fresh);
      setQuizTopic(focus);
      setQuizNo((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setQuizBusy(false);
    }
  };

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [turns, asking]);

  return (
    <section className="panel">
      <h2 className="section-title">Ask about your level</h2>
      {turns.length === 0 && (
        <p className="muted">
          {reviewed === 0
            ? "Your coach reads the review written at the end of each session. You have none yet — finish a session with “End & review”, ideally a Level check, and then ask away. Quizzes work already."
            : `Put your questions to a DELF examiner who has read all ${reviewed} of your session reviews, every mistake you have logged and your measured speaking speed. Answers are in English.`}
        </p>
      )}
      {turns.length > 0 && (
        <div className="coach__log" ref={log}>
          {turns.map((t, i) => (
            <div key={i} className={`turn turn--${t.role === "student" ? "student" : "tutor"}`}>
              <div className={`bubble bubble--${t.role === "student" ? "student" : "tutor"}`}>
                {t.role === "coach" ? <CoachText text={t.text} /> : t.text}
              </div>
            </div>
          ))}
          {asking && (
            <div className="turn turn--tutor">
              <div className="bubble bubble--tutor typing" aria-label="Thinking">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={turns.length ? "Ask something else" : "Am I ready for B1?"}
          aria-label="Your question"
        />
        <button className="btn btn--primary" disabled={asking || !draft.trim()}>
          {asking ? "Thinking…" : "Ask"}
        </button>
      </form>
      {turns.length === 0 && (
        <div className="coach__starters">
          {STARTER_QUESTIONS.map((q) => (
            <button key={q} className="starter" onClick={() => void ask(q)} disabled={asking}>
              {q}
            </button>
          ))}
        </div>
      )}
      {suggested && (
        <div className="row">
          <button className="btn btn--primary" disabled={quizBusy} onClick={() => void makeQuiz(suggested)}>
            {quizBusy ? "Writing your quiz…" : `Quiz me on ${suggested}`}
          </button>
        </div>
      )}
      <details className="coach__quiz">
        <summary>Quiz me on something else</summary>
        <div className="row">
          <input
            className="input"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. the subjonctif after il faut que"
            aria-label="Quiz topic"
          />
          <button className="btn" disabled={quizBusy} onClick={() => void makeQuiz(topic.trim() || null)}>
            {quizBusy ? "Writing…" : topic.trim() ? "Make this quiz" : "Quiz my weak spots"}
          </button>
        </div>
      </details>
      {questions && questions.length > 0 && (
        <>
          <h3 className="subhead">{quizTopic ? `Quiz: ${quizTopic}` : "Quiz on your weak spots"}</h3>
          <QuizPlayer
            key={quizNo}
            questions={questions}
            listen={voice ? listen : undefined}
            onNew={() => void makeQuiz(quizTopic)}
            newLabel="Another quiz"
            busy={quizBusy}
            footer={
              <button className="btn btn--ghost" onClick={() => setQuestions(null)}>
                Close
              </button>
            }
          />
        </>
      )}
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
      {detail && <span className="stat__detail">{detail}</span>}
    </div>
  );
}

/** The middle value, which a single very slow turn cannot drag around the way a mean can. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * How long she takes to answer, and where that time goes.
 *
 * The wait used to be argued about from memory, which is no way to tell a slow transcription from a
 * slow model - they feel identical. Each stage is timed in the browser from the moment the student
 * stops talking, and shown here so a change to the pipeline can be judged instead of hoped about.
 */
function ResponsePanel() {
  const [timings, setTimings] = useState<TurnTiming[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .get<{ timings: TurnTiming[] }>("/api/timing")
      .then((d) => setTimings(d.timings))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null; // a missing read-out is not worth an error on this page
  if (!timings) return null;

  const recent = timings.slice(-60);
  if (recent.length === 0) {
    return (
      <section className="panel">
        <h2 className="section-title">How quickly she answers</h2>
        <p className="muted">
          Nothing timed yet. Speak a few answers in a session and each turn is measured here, from the moment you stop talking to the moment you hear
          her.
        </p>
      </section>
    );
  }

  // "Started early" means transcription had already begun during the pause. Both kinds are kept so
  // the two can be compared rather than taken on trust.
  const overlapped = recent.filter((t) => t.early);
  const plain = recent.filter((t) => !t.early);
  const stages: [string, (t: TurnTiming) => number, string][] = [
    ["Waiting to be sure you'd finished", (t) => t.endpointMs, "the pause at the end of your turn"],
    ["Transcribing what you said", (t) => t.transcribeMs, "shorter when it began during your pause"],
    ["Her writing the first sentence", (t) => t.brainMs, "the model; little of this can be removed"],
    ["Turning it into her voice", (t) => t.voiceMs, "the voice server"],
  ];
  const wordsNow = median(recent.map((t) => t.wordsMs));
  const soundNow = median(recent.map((t) => t.firstSoundMs));
  const restarted = recent.filter((t) => t.restarted).length;

  return (
    <section className="panel">
      <h2 className="section-title">How quickly she answers</h2>
      <p className="small">
        Measured from the moment you stop talking, over your last {recent.length} spoken {recent.length === 1 ? "turn" : "turns"}. Middle values, not
        averages, so one slow turn doesn&rsquo;t distort them.
      </p>
      <div className="stats">
        <Stat label="before you hear anything" value={seconds(soundNow)} detail={soundNow < wordsNow ? "a thinking noise fills this" : undefined} />
        <Stat label="before her first word" value={seconds(wordsNow)} detail="the one that decides whether this feels like a person" />
        <Stat label="turns measured" value={recent.length} detail={restarted ? `${restarted} restarted because you carried on` : undefined} />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Where the time goes</th>
            <th>Started early</th>
            <th>Started after</th>
          </tr>
        </thead>
        <tbody>
          {stages.map(([label, of, note]) => (
            <tr key={label}>
              <td>
                {label}
                <br />
                <span className="small muted">{note}</span>
              </td>
              <td>{overlapped.length ? seconds(median(overlapped.map(of))) : "–"}</td>
              <td>{plain.length ? seconds(median(plain.map(of))) : "–"}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Her first word</strong>
            </td>
            <td>
              <strong>{overlapped.length ? seconds(median(overlapped.map((t) => t.wordsMs))) : "–"}</strong>
            </td>
            <td>
              <strong>{plain.length ? seconds(median(plain.map((t) => t.wordsMs))) : "–"}</strong>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="small muted">
        {overlapped.length && plain.length
          ? "Both columns have turns in them, so the comparison is a real one. The switches are in Settings, under “Keeping up with you”."
          : overlapped.length
            ? "Every turn here started early. To compare, turn that off in Settings for a few turns."
            : "No turn here started early yet. Turn that on in Settings to see the difference."}
      </p>
    </section>
  );
}

function SpeakingPanel({ speaking }: { speaking: ProgressData["speaking"] }) {
  const { week, previousWeek, month, allTime, today } = speaking;
  const change = week && previousWeek ? week.wpm - previousWeek.wpm : null;
  const periods: [string, FluencyAverage | null][] = [
    ["Today", today],
    ["Last 7 days", week],
    ["This month", month],
    ["All time", allTime],
  ];

  return (
    <section className="panel">
      <h2 className="section-title">Speaking speed</h2>
      {!allTime ? (
        <p className="muted">No spoken answers measured yet. Use the microphone in a session and your speaking speed is tracked automatically.</p>
      ) : (
        <>
          <div className="stats">
            <Stat
              label="words per minute, last 7 days"
              value={week ? week.wpm : "–"}
              detail={change === null ? undefined : `${change >= 0 ? "▲" : "▼"} ${Math.abs(change)} vs the week before`}
            />
            <Stat label="wpm while talking (no pauses)" value={week ? week.articulationWpm : "–"} />
            <Stat label="pauses per minute" value={week ? week.pausesPerMinute : "–"} />
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Answers</th>
                  <th className="num">Words / min</th>
                  <th className="num">While talking</th>
                  <th className="num">Pauses / min</th>
                </tr>
              </thead>
              <tbody>
                {periods.map(([label, avg]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num">{avg?.turns ?? 0}</td>
                    <td className="num">{avg?.wpm ?? "–"}</td>
                    <td className="num">{avg?.articulationWpm ?? "–"}</td>
                    <td className="num">{avg?.pausesPerMinute ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="small muted">
        Rough conversational pace: {PACE_GUIDE.map((p) => `${p.level} ${p.range}`).join(" · ")} words per minute. People vary a lot, so watch your own
        trend. Fewer, shorter pauses usually matter more than raw speed.
      </p>
    </section>
  );
}

function ProfileForm({ profile, onSaved }: { profile: LearnerProfile; onSaved: (profile: LearnerProfile) => void }) {
  const [form, setForm] = useState(profile);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof LearnerProfile>(key: K, value: LearnerProfile[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { profile: updated } = await api.put<{ profile: LearnerProfile }>("/api/profile", form);
      setForm(updated);
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form" onSubmit={save}>
      <label className="field">
        <span>Your name</span>
        <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="What should your tutor call you?" />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Current level</span>
          <select className="input" value={form.currentLevel} onChange={(e) => set("currentLevel", e.target.value as CefrLevel)}>
            {CEFR_LEVELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Goal level</span>
          <select className="input" value={form.targetLevel} onChange={(e) => set("targetLevel", e.target.value as CefrLevel)}>
            {CEFR_LEVELS.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Where you live</span>
          <input className="input" value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} placeholder="e.g. Dunkerque" />
        </label>
        <label className="field">
          <span>Where you work</span>
          <input className="input" value={form.employer ?? ""} onChange={(e) => set("employer", e.target.value)} placeholder="Company or organisation" />
        </label>
        <label className="field">
          <span>Your job</span>
          <input className="input" value={form.role ?? ""} onChange={(e) => set("role", e.target.value)} placeholder="e.g. project manager" />
        </label>
      </div>
      <p className="small muted">
        These three are optional, and they exist to stop the end-of-session review inventing details about you: without them it has been known to
        write a plan around a city you&apos;ve never lived in.
      </p>
      <label className="field">
        <span>Why you&apos;re learning French</span>
        <textarea
          className="input"
          rows={3}
          value={form.goals}
          onChange={(e) => set("goals", e.target.value)}
          placeholder="e.g. pass DELF B1 by June, chat with my partner's family, work in Lyon"
        />
      </label>
      <fieldset className="field">
        <legend>Corrections</legend>
        <label className="radio">
          <input type="radio" name="correctionStyle" checked={form.correctionStyle === "gentle"} onChange={() => set("correctionStyle", "gentle")} />
          <span>
            <strong>Gentle</strong>: she repeats your sentence back correctly and keeps the conversation flowing. Details appear on screen.
          </span>
        </label>
        <label className="radio">
          <input type="radio" name="correctionStyle" checked={form.correctionStyle === "explicit"} onChange={() => set("correctionStyle", "explicit")} />
          <span>
            <strong>Explicit</strong>: she points out your most important mistake out loud each turn.
          </span>
        </label>
      </fieldset>
      <p className="small muted">
        Voice and AI model choices are on the <Link href="/settings">Settings</Link> page.
      </p>
      <div className="row">
        <button className="btn btn--primary" disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        {saved && <span className="muted small">Saved</span>}
      </div>
      {error && <div className="alert">{error}</div>}
    </form>
  );
}
