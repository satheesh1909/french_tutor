"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  CATEGORY_LABELS,
  CEFR_LEVELS,
  MODE_LABELS,
  ROLEPLAY_SCENARIOS,
  type CefrLevel,
  type ErrorCategory,
  type LearnerProfile,
  type MistakeRecord,
  type SessionSummary,
} from "@/lib/types";
import { api, errorMessage } from "./api";
import { formatDate } from "./format";

interface ProgressData {
  profile: LearnerProfile;
  sessions: SessionSummary[];
  categories: { category: ErrorCategory; count: number }[];
  topMistakes: MistakeRecord[];
  mistakeCount: number;
  cards: { total: number; due: number; mature: number };
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
                        {s.turnCount} turns · {s.correctionCount} corrections{s.review ? ` · ${s.review.levels.overall}` : ""}
                      </span>
                    </summary>
                    {s.review ? (
                      <div className="session-review">
                        <p>{s.review.summary}</p>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
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
      <label className="field">
        <span>Tutor voice</span>
        <select className="input" value={form.voice} onChange={(e) => set("voice", e.target.value as LearnerProfile["voice"])}>
          <option value="gemini">Gemini: natural, needs a Gemini key</option>
          <option value="browser">Browser: free and instant, more robotic</option>
        </select>
      </label>
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
