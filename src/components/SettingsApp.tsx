"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AVATAR_MODE_LABELS,
  AVATAR_MODES,
  BRAIN_JOBS,
  EFFORTS,
  END_SILENCE_RANGE,
  FEATURE_LABELS,
  GEMINI_VOICES,
  JOB_LABELS,
  KEY_LABELS,
  KEY_PROVIDERS,
  MIC_SENSITIVITIES,
  nearestEffort,
  PROVIDERS,
  PROVIDER_LABELS,
  USAGE_PROVIDER_LABELS,
  VOICE_REGISTERS,
  voiceRegister,
  type AppSettings,
  type AvatarSettings,
  type BrainJob,
  type ConversationSettings,
  type Effort,
  type KeyProvider,
  type KeyStatus,
  type MicSensitivity,
  type ModelChoice,
  type Provider,
  type SettingsOptions,
  type SpeechSegment,
  type UsageProvider,
  type UsageReport,
  type UsageRow,
  type UsageTotals,
  type VoiceRegister,
  type VoiceSettings,
} from "@/lib/types";
import { api, errorMessage } from "./api";
import { loadVoices, speak } from "./voice";

interface Option {
  value: string;
  label: string;
}

// When switching provider, start from a sensible model rather than whatever sorts first.
const PREFERRED_MODELS: Record<Provider, string[]> = {
  claude: ["claude-opus-5", "claude-sonnet-5"],
  gemini: ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest"],
  ollama: ["llama3:8b"],
};

function modelOptions(provider: Provider, options: SettingsOptions): Option[] {
  switch (provider) {
    case "claude":
      // The tutor needs structured answers; older models that can't give them aren't offered.
      return options.claude.models.filter((m) => m.structuredOutputs).map((m) => ({ value: m.id, label: `${m.label} (${m.id})` }));
    case "gemini":
      return options.gemini.text.map((n) => ({ value: n, label: n }));
    case "ollama":
      return options.ollama.chat.map((m) => ({ value: m.name, label: `${m.name} · ${m.parameterSize}` }));
  }
}

/** Keeps the saved choice visible even if the service didn't list it right now. */
function withCurrent(list: Option[], current: string): Option[] {
  if (!current || list.some((o) => o.value === current)) return list;
  return [{ value: current, label: `${current} (not currently available)` }, ...list];
}

/** Effort levels a Claude model accepts. If the model isn't in the list, assume all and let the server adjust. */
function claudeEfforts(model: string, options: SettingsOptions): readonly Effort[] {
  return options.claude.models.find((m) => m.id === model)?.efforts ?? EFFORTS;
}

function isAvailable(provider: Provider, options: SettingsOptions): boolean {
  return provider === "claude" ? options.claude.connected : provider === "gemini" ? options.gemini.connected : options.ollama.online;
}

export function SettingsApp() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [options, setOptions] = useState<SettingsOptions | null>(null);
  const [keys, setKeys] = useState<Record<KeyProvider, KeyStatus> | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Required<SettingsResponse>>("/api/settings")
      .then((r) => {
        setSettings(r.settings);
        setSavedJson(JSON.stringify(r.settings));
        setOptions(r.options);
        setKeys(r.keys);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const update = (change: (s: AppSettings) => AppSettings) => {
    setSettings((s) => s && change(s));
    setJustSaved(false);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.put<SettingsResponse>("/api/settings", settings);
      setSettings(r.settings);
      setSavedJson(JSON.stringify(r.settings));
      setKeys(r.keys);
      setJustSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!settings || !options || !keys) {
    return error ? <div className="alert">{error}</div> : <p className="muted">Loading settings and available models…</p>;
  }

  const dirty = JSON.stringify(settings) !== savedJson;
  const setJob = (job: BrainJob, choice: ModelChoice) => update((s) => ({ ...s, models: { ...s.models, [job]: choice } }));

  return (
    <div className="settings">
      <header className="settings__head">
        <h1>Settings</h1>
        <p className="muted">Choose which AI does each job and how your tutor sounds, and see how many tokens you&apos;ve used.</p>
      </header>

      <Connections
        options={options}
        keys={keys}
        onKeysSaved={(r) => {
          setKeys(r.keys);
          // A new key means new model lists. Don't discard edits that haven't been saved yet.
          if (JSON.stringify(settings) === savedJson) {
            setSettings(r.settings);
            setSavedJson(JSON.stringify(r.settings));
          }
          api
            .get<Required<SettingsResponse>>("/api/settings")
            .then((fresh) => setOptions(fresh.options))
            .catch(() => undefined);
        }}
      />

      <section className="panel">
        <h2 className="section-title">AI models</h2>
        <div className="jobs">
          {BRAIN_JOBS.map((job) => (
            <JobRow key={job} job={job} choice={settings.models[job]} options={options} onChange={(c) => setJob(job, c)} />
          ))}

          <TranscriptionRow
            value={settings.transcription}
            options={options}
            onChange={(transcription) => update((s) => ({ ...s, transcription }))}
          />

          <div className="job">
            <div className="job__label">
              <strong>Mistake memory</strong>
              <span className="small muted">Groups repeated mistakes and reminds the tutor of similar past ones. Runs on your computer.</span>
            </div>
            <div className="job__controls">
              <span className="tag">Local (Ollama)</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.memory.enabled}
                  onChange={(e) => update((s) => ({ ...s, memory: { ...s.memory, enabled: e.target.checked } }))}
                />
                <span>{settings.memory.enabled ? "On" : "Off"}</span>
              </label>
              <select
                className="input"
                aria-label="Embedding model"
                value={settings.memory.model}
                disabled={!settings.memory.enabled}
                onChange={(e) => update((s) => ({ ...s, memory: { ...s.memory, model: e.target.value } }))}
              >
                {withCurrent(
                  options.ollama.embedding.map((m) => ({ value: m.name.replace(/:latest$/, ""), label: `${m.name} · ${m.parameterSize}` })),
                  settings.memory.model,
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <ConversationPanel value={settings.conversation} onChange={(conversation) => update((s) => ({ ...s, conversation }))} />

      <VoicePanel voice={settings.voice} options={options} onChange={(voice) => update((s) => ({ ...s, voice }))} />

      <AvatarPanel avatar={settings.avatar} onChange={(avatar) => update((s) => ({ ...s, avatar }))} />

      <UsagePanel />

      {error && <div className="alert">{error}</div>}
      {(dirty || justSaved) && (
        <div className="savebar" role="status">
          <span>{dirty ? "You have unsaved changes." : "Saved. Changes apply from your next message."}</span>
          {dirty && (
            <div className="row">
              <button className="btn btn--ghost" onClick={() => update(() => JSON.parse(savedJson) as AppSettings)}>
                Discard
              </button>
              <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SettingsResponse {
  settings: AppSettings;
  keys: Record<KeyProvider, KeyStatus>;
  keyTests?: Partial<Record<KeyProvider, string | null>>;
  options?: SettingsOptions;
}

function Connections({
  options,
  keys,
  onKeysSaved,
}: {
  options: SettingsOptions;
  keys: Record<KeyProvider, KeyStatus>;
  onKeysSaved: (r: SettingsResponse) => void;
}) {
  const items = [
    {
      name: "Claude",
      ok: options.claude.connected,
      detail: options.claude.connected ? `${options.claude.models.length} models available` : "Add a key below to use Claude",
    },
    {
      name: "Gemini",
      ok: options.gemini.connected,
      detail: options.gemini.connected
        ? `${options.gemini.text.length} text, ${options.gemini.tts.length} voice and ${options.gemini.transcribe.length} transcription models`
        : "Add a key below for her voice, her ears and quizzes",
    },
    {
      name: "Local (Ollama)",
      ok: options.ollama.online,
      detail: options.ollama.online
        ? `${options.ollama.chat.length} chat and ${options.ollama.embedding.length} embedding models installed`
        : "Start Ollama to use local models (no key needed)",
    },
  ];
  return (
    <section className="panel">
      <h2 className="section-title">Connections</h2>
      <ul className="connections">
        {items.map((i) => (
          <li key={i.name} className={`connection${i.ok ? " connection--ok" : ""}`}>
            <span className="connection__dot" aria-hidden="true" />
            <div>
              <strong>{i.name}</strong>
              <span className="small muted">
                {i.ok ? "Connected" : "Not connected"} &middot; {i.detail}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="subhead">API keys</h3>
      <div className="keys">
        {KEY_PROVIDERS.map((provider) => (
          <KeyRow key={provider} provider={provider} status={keys[provider]} onSaved={onKeysSaved} />
        ))}
      </div>
      <p className="small muted">
        A key saved here is kept in <code>data/secrets.json</code> on this computer, is never shown again, and goes nowhere except to Anthropic or
        Google. It works immediately, with no restart. Keys in <code>.env.local</code> still work too, and a key saved here overrides them.
      </p>
    </section>
  );
}

function KeyRow({ provider, status, onSaved }: { provider: KeyProvider; status: KeyStatus; onSaved: (r: SettingsResponse) => void }) {
  const label = KEY_LABELS[provider];
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const send = async (key: string) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.put<SettingsResponse>("/api/settings", { keys: { [provider]: key } });
      setValue("");
      setEditing(false);
      const failure = r.keyTests?.[provider];
      setResult(
        key === "" ? { ok: true, message: "Key removed." } : failure ? { ok: false, message: failure } : { ok: true, message: "Saved, and it works." },
      );
      onSaved(r);
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const saved = status.source === "app";
  const fromEnv = status.source === "environment";

  return (
    <div className="key">
      <div className="key__top">
        <strong>{label.title}</strong>
        <span className="small muted">
          {saved ? `Saved in the app, ending ${status.hint}` : fromEnv ? `From .env.local, ending ${status.hint}` : "No key yet"}
        </span>
      </div>
      {editing || status.source === "none" ? (
        <div className="row">
          <input
            className="input"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) void send(value.trim());
            }}
            placeholder={provider === "claude" ? "sk-ant-..." : "Paste your Gemini key"}
            aria-label={`${label.title} API key`}
            autoComplete="off"
            spellCheck={false}
          />
          <button className="btn btn--primary" disabled={busy || !value.trim()} onClick={() => void send(value.trim())}>
            {busy ? "Checking..." : "Save key"}
          </button>
          {editing && (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setValue("");
              }}
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
            {saved ? "Replace key" : "Save a key here instead"}
          </button>
          {saved && (
            <button className="btn btn--ghost" disabled={busy} onClick={() => void send("")}>
              Remove
            </button>
          )}
        </div>
      )}
      <p className="small muted">
        Get one from{" "}
        <a href={label.url} target="_blank" rel="noreferrer">
          {label.where}
        </a>
        .
      </p>
      {result && <p className={`small ${result.ok ? "key__ok" : "key__bad"}`}>{result.message}</p>}
    </div>
  );
}

function JobRow({ job, choice, options, onChange }: { job: BrainJob; choice: ModelChoice; options: SettingsOptions; onChange: (c: ModelChoice) => void }) {
  const efforts = choice.provider === "claude" ? claudeEfforts(choice.model, options) : [];

  // Keep the saved effort to one the chosen Claude model accepts.
  const change = (next: ModelChoice) => {
    const supported = next.provider === "claude" ? claudeEfforts(next.model, options) : [];
    onChange({ ...next, effort: nearestEffort(next.effort, supported) ?? next.effort });
  };

  const switchProvider = (provider: Provider) => {
    if (provider === choice.provider) return;
    const available = modelOptions(provider, options).map((o) => o.value);
    const model = PREFERRED_MODELS[provider].find((m) => available.includes(m)) ?? available[0] ?? "";
    change({ ...choice, provider, model });
  };

  return (
    <div className="job">
      <div className="job__label">
        <strong>{JOB_LABELS[job].title}</strong>
        <span className="small muted">{JOB_LABELS[job].description}</span>
      </div>
      <div className="job__controls">
        <div className="segmented" role="radiogroup" aria-label={`${JOB_LABELS[job].title}: provider`}>
          {PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={choice.provider === p}
              className="seg-btn"
              disabled={!isAvailable(p, options) && choice.provider !== p}
              onClick={() => switchProvider(p)}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
        <select className="input" aria-label={`${JOB_LABELS[job].title}: model`} value={choice.model} onChange={(e) => change({ ...choice, model: e.target.value })}>
          {withCurrent(modelOptions(choice.provider, options), choice.model).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {choice.provider === "claude" &&
          (efforts.length > 0 ? (
            <label className="inline-field" title="Low is fastest; high and above think more carefully and use more tokens.">
              <span>Effort</span>
              <select className="input" value={choice.effort} onChange={(e) => onChange({ ...choice, effort: e.target.value as Effort })}>
                {efforts.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="small muted">This model has no effort setting</span>
          ))}
      </div>
      {choice.provider === "ollama" && (
        <p className="warn small">
          {job === "quiz"
            ? "Small local models can write quiz answers that are wrong. Double-check anything surprising."
            : "Local models are free and private, but in testing an 8B model gave wrong grammar corrections. Fine for casual practice; use Claude when accuracy matters."}
        </p>
      )}
    </div>
  );
}

function TranscriptionRow({
  value,
  options,
  onChange,
}: {
  value: AppSettings["transcription"];
  options: SettingsOptions;
  onChange: (v: AppSettings["transcription"]) => void;
}) {
  const whisper = options.whisper;
  const whisperOnly = value.engine === "whisper";
  return (
    <div className="job">
      <div className="job__label">
        <strong>Speech to text and speaking speed</strong>
        <span className="small muted">How your recordings become text, and how your speaking speed is measured</span>
      </div>
      <div className="job__controls">
        <div className="segmented" role="radiogroup" aria-label="Transcription engine">
          <button
            type="button"
            role="radio"
            className="seg-btn"
            aria-checked={value.engine === "gemini"}
            disabled={!options.gemini.connected && value.engine !== "gemini"}
            onClick={() => onChange({ ...value, engine: "gemini" })}
          >
            Gemini
          </button>
          <button
            type="button"
            role="radio"
            className="seg-btn"
            aria-checked={whisperOnly}
            disabled={!whisper.online && !whisperOnly}
            onClick={() => onChange({ ...value, engine: "whisper" })}
          >
            Whisper (local)
          </button>
        </div>
        {!whisperOnly && (
          <select className="input" aria-label="Gemini transcription model" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
            {withCurrent(
              options.gemini.transcribe.map((n) => ({ value: n, label: n })),
              value.model,
            ).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <label className="switch">
        <input
          type="checkbox"
          checked={whisperOnly || value.whisperTiming}
          disabled={whisperOnly}
          onChange={(e) => onChange({ ...value, whisperTiming: e.target.checked })}
        />
        <span>Measure speaking speed with Whisper&apos;s word timings (runs alongside Gemini, no extra wait)</span>
      </label>
      <p className={`small ${whisper.online ? "muted" : "warn"}`}>
        {whisper.online ? (
          <>
            Whisper server running: <code>{whisper.model}</code> on {whisper.device === "cuda" ? "your GPU" : "the CPU"}.
          </>
        ) : (
          <>
            Whisper server not running. Start it with <code>npm run whisper</code>. Until then, speaking speed is estimated from the recording itself.
          </>
        )}
      </p>
      <p className="small muted">
        Gemini keeps small slips and handles French and English in one recording. Whisper is free and offline, but it may tidy slips like
        &ldquo;que il&rdquo; and expects one language per recording.
      </p>
    </div>
  );
}

const SENSITIVITY_LABELS: Record<MicSensitivity, string> = {
  low: "Low (noisy room)",
  medium: "Medium",
  high: "High (quiet voice)",
};

function ConversationPanel({ value, onChange }: { value: ConversationSettings; onChange: (v: ConversationSettings) => void }) {
  const set = (patch: Partial<ConversationSettings>) => onChange({ ...value, ...patch });
  return (
    <section className="panel">
      <h2 className="section-title">Conversation</h2>
      <label className="switch">
        <input type="checkbox" checked={value.handsFree} onChange={(e) => set({ handsFree: e.target.checked })} />
        <span>
          <strong>Hands-free:</strong> the microphone stays on during a session and your answer is sent automatically when you pause. Turn off to use
          the Speak button or hold Space instead.
        </span>
      </label>
      <label className="field">
        <span>
          Send my answer after a pause of <strong>{(value.endSilenceMs / 1000).toFixed(1)} s</strong>
        </span>
        <input
          type="range"
          min={END_SILENCE_RANGE.min}
          max={END_SILENCE_RANGE.max}
          step={100}
          value={value.endSilenceMs}
          disabled={!value.handsFree}
          onChange={(e) => set({ endSilenceMs: Number(e.target.value) })}
        />
        <span className="small">
          Longer gives you time to think mid-sentence. If you carry on after your answer was sent, the tutor waits and treats it all as one answer.
        </span>
      </label>
      <div className="field">
        <span>Microphone sensitivity</span>
        <div className="segmented" role="radiogroup" aria-label="Microphone sensitivity">
          {MIC_SENSITIVITIES.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              className="seg-btn"
              aria-checked={value.sensitivity === s}
              disabled={!value.handsFree}
              onClick={() => set({ sensitivity: s })}
            >
              {SENSITIVITY_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={value.bargeIn} disabled={!value.handsFree} onChange={(e) => set({ bargeIn: e.target.checked })} />
        <span>
          <strong>Let me interrupt:</strong> speaking while the tutor talks stops her and she listens. With speakers instead of headphones, she may
          hear herself; turn this off if she keeps stopping mid-sentence.
        </span>
      </label>
    </section>
  );
}

const PREVIEW: SpeechSegment[] = [
  { lang: "en", text: "Hello! I'm your French tutor. Shall we practise a little today?" },
  { lang: "fr", text: "Bonjour ! Aujourd'hui, on va parler de ton week-end. Tu es prêt ?" },
];

function VoicePanel({ voice, options, onChange }: { voice: VoiceSettings; options: SettingsOptions; onChange: (v: VoiceSettings) => void }) {
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  /** Which voice is playing right now: a Gemini voice name, "current", or null. */
  const [playing, setPlaying] = useState<string | null>(null);
  const player = useRef<AbortController | null>(null);

  useEffect(() => {
    if ("speechSynthesis" in window) void loadVoices(window.speechSynthesis).then(setBrowserVoices);
    return () => player.current?.abort();
  }, []);

  const set = (patch: Partial<VoiceSettings>) => onChange({ ...voice, ...patch });
  const byLocale = (prefix: string, preferred: string) =>
    browserVoices
      .filter((v) => v.lang.toLowerCase().startsWith(prefix))
      .sort((a, b) => Number(b.lang.toLowerCase().replace("_", "-") === preferred) - Number(a.lang.toLowerCase().replace("_", "-") === preferred));
  const english = byLocale("en", "en-gb");
  const french = byLocale("fr", "fr-fr");

  /** Plays the sample in one voice. Passing a voice name tries it without selecting it. */
  const togglePreview = async (geminiVoice?: string) => {
    const key = geminiVoice ?? "current";
    const wasPlaying = playing;
    player.current?.abort();
    player.current = null;
    setPlaying(null);
    if (wasPlaying === key) return; // pressing the same button again stops it

    const controller = new AbortController();
    player.current = controller;
    setPlaying(key);
    try {
      await speak(PREVIEW, geminiVoice ? { ...voice, provider: "gemini", geminiVoice } : voice, { current: 0 }, controller.signal);
    } finally {
      if (player.current === controller) {
        player.current = null;
        setPlaying(null);
      }
    }
  };

  return (
    <section className="panel">
      <h2 className="section-title">Voice</h2>
      <div className="choices" role="radiogroup" aria-label="Voice provider">
        <button role="radio" aria-checked={voice.provider === "gemini"} className="choice" disabled={!options.gemini.connected} onClick={() => set({ provider: "gemini" })}>
          <strong>Gemini voice</strong>
          <span>Natural. British accent in English, native accent in French. Uses Gemini tokens.</span>
        </button>
        <button role="radio" aria-checked={voice.provider === "browser"} className="choice" onClick={() => set({ provider: "browser" })}>
          <strong>Browser voice</strong>
          <span>Free and instant, using voices installed on this computer. Sounds more robotic.</span>
        </button>
      </div>

      {voice.provider === "gemini" ? (
        <>
          <div className="field">
            <span>Voice — press play to hear one before choosing it</span>
            {(["higher", "lower"] as VoiceRegister[]).map((register) => (
              <div key={register}>
                <p className="voice-group">
                  {VOICE_REGISTERS[register].label} <span className="muted">({VOICE_REGISTERS[register].hint})</span>
                </p>
                <div className="voice-grid" role="radiogroup" aria-label={`${VOICE_REGISTERS[register].label} Gemini voices`}>
                  {GEMINI_VOICES.filter((v) => voiceRegister(v.hz) === register).map((v) => (
                    <div key={v.name} className={`voice-option${voice.geminiVoice === v.name ? " voice-option--active" : ""}`}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={voice.geminiVoice === v.name}
                        className="voice-option__pick"
                        onClick={() => set({ geminiVoice: v.name })}
                      >
                        <strong>{v.name}</strong>
                        <span>
                          {v.style} · {v.hz} Hz
                        </span>
                      </button>
                      <button
                        type="button"
                        className="voice-option__play"
                        aria-label={playing === v.name ? `Stop ${v.name}` : `Hear ${v.name}`}
                        onClick={() => void togglePreview(v.name)}
                      >
                        {playing === v.name ? "■" : "▶"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <span className="small muted">
              Google doesn&apos;t publish a gender for these voices, so each one here is grouped by the pitch we measured from a sample of it. Whichever
              you choose, she is asked to speak British English and native-sounding French.
            </span>
          </div>
          <label className="field">
            <span>Voice model</span>
            <select className="input" value={voice.geminiModel} onChange={(e) => set({ geminiModel: e.target.value })}>
              {withCurrent(
                options.gemini.tts.map((n) => ({ value: n, label: n })),
                voice.geminiModel,
              ).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <div className="field-row">
          <label className="field">
            <span>English voice</span>
            <select className="input" value={voice.browserVoiceEn} onChange={(e) => set({ browserVoiceEn: e.target.value })}>
              <option value="">Automatic (British if available)</option>
              {english.map((v) => (
                <option key={v.voiceURI} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>French voice</span>
            <select className="input" value={voice.browserVoiceFr} onChange={(e) => set({ browserVoiceFr: e.target.value })}>
              <option value="">Automatic (France if available)</option>
              {french.map((v) => (
                <option key={v.voiceURI} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="row">
        <button type="button" className="btn" onClick={() => void togglePreview()}>
          {playing === "current" ? "Stop" : "Preview the chosen voice"}
        </button>
        <span className="small muted">
          Plays a short English and French sample{voice.provider === "gemini" ? " and uses a few Gemini tokens" : ""}. You can preview before saving.
        </span>
      </div>
    </section>
  );
}

const fullNumber = new Intl.NumberFormat();
const shortNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
// Local models (Ollama and Whisper) share one card; they run on this computer at no cost.
const CARDS: { key: string; title: string; providers: UsageProvider[]; note?: string }[] = [
  { key: "local", title: "Local (Ollama + Whisper)", providers: ["ollama", "whisper"], note: "Runs on your computer at no cost. Whisper counts output tokens only." },
  { key: "gemini", title: "Gemini", providers: ["gemini"] },
  { key: "claude", title: "Claude", providers: ["claude"] },
];
const dayName = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function totalFor(rows: UsageRow[], providers: UsageProvider[]): UsageTotals {
  const t: UsageTotals = { input: 0, output: 0, cached: 0, calls: 0 };
  for (const r of rows) {
    if (!providers.includes(r.provider)) continue;
    t.input += r.input;
    t.output += r.output;
    t.cached += r.cached;
    t.calls += r.calls;
  }
  return t;
}

function AvatarPanel({ avatar, onChange }: { avatar: AvatarSettings; onChange: (a: AvatarSettings) => void }) {
  const [url, setUrl] = useState(avatar.modelUrl);
  const [server, setServer] = useState<{ online: boolean; starting: boolean; device: string | null; faces: string[] } | null>(null);
  const set = (patch: Partial<AvatarSettings>) => onChange({ ...avatar, ...patch });

  useEffect(() => {
    if (avatar.mode !== "photo") return;
    const check = () =>
      api
        .get<{ avatarServer: typeof server }>("/api/health")
        .then((h) => setServer(h.avatarServer))
        .catch(() => setServer(null));
    void check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, [avatar.mode]);

  return (
    <section className="panel">
      <h2 className="section-title">Avatar</h2>
      <div className="segmented" role="radiogroup" aria-label="Avatar">
        {AVATAR_MODES.map((mode) => (
          <button
            key={mode}
            role="radio"
            aria-checked={avatar.mode === mode}
            className={`seg-btn${avatar.mode === mode ? " seg-btn--on" : ""}`}
            onClick={() => set({ mode })}
          >
            {AVATAR_MODE_LABELS[mode].title}
          </button>
        ))}
      </div>
      <p className="small muted">{AVATAR_MODE_LABELS[avatar.mode].description}.</p>

      {avatar.mode === "photo" && (
        <>
          <div className="photo-row">
            <img className="photo-row__face" src={`/api/avatar/face?name=${encodeURIComponent(avatar.photo || "charlotte")}`} alt="" />
            <div>
              <p className={`small ${server?.online ? "key__ok" : "key__bad"}`}>
                {server?.online
                  ? `Lip-sync server ready on the ${server.device?.toUpperCase() ?? "GPU"}.`
                  : server?.starting
                    ? "Lip-sync server is warming up, about a minute…"
                    : "Lip-sync server isn't running."}
              </p>
              <p className="small muted">
                {server?.online ? (
                  <>She renders each reply on your own machine, so it costs nothing and nothing leaves this computer.</>
                ) : (
                  <>
                    Start it with <code>npm run avatar</code> (or use <code>start-tutor.cmd</code>, which starts everything). Until then she still
                    talks, but the photo stays still.
                  </>
                )}
              </p>
              {server && server.faces.length > 1 && (
                <label className="field">
                  <span>Photo</span>
                  <select className="input" value={avatar.photo} onChange={(e) => set({ photo: e.target.value })}>
                    {server.faces.map((face) => (
                      <option key={face} value={face}>
                        {face}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>
          <p className="small muted">
            To use a different face, drop a front-facing portrait into <code>avatar_server/faces</code> and restart the avatar server. A photo picker
            in the app is coming later.
          </p>
        </>
      )}

      {avatar.mode === "3d" && (
        <label className="field">
          <span>Your own 3D head (optional)</span>
          <div className="row">
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => set({ modelUrl: url.trim() })}
              placeholder="https://models.readyplayer.me/xxxxxxxx.glb"
              aria-label="Avatar model URL"
              spellCheck={false}
            />
            {avatar.modelUrl && (
              <button
                className="btn btn--ghost"
                onClick={() => {
                  setUrl("");
                  set({ modelUrl: "" });
                }}
              >
                Use the built-in head
              </button>
            )}
          </div>
          <span className="small muted">
            Paste a link to a <code>.glb</code> head and she wears it instead. Make a realistic one free at{" "}
            <a href="https://readyplayer.me" target="_blank" rel="noreferrer">
              readyplayer.me
            </a>{" "}
            and copy its .glb link: those carry the blend shapes her lip-sync needs. The model is downloaded by your browser each time.
          </span>
        </label>
      )}
    </section>
  );
}

function UsagePanel() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [period, setPeriod] = useState<"today" | "month">("today");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<UsageReport>("/api/usage")
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const rows = report ? (period === "today" ? report.todayRows : report.monthRows) : [];
  const monthName = report ? new Date(`${report.month}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "";

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="section-title">Token usage</h2>
        <button className="link" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={period === "today"} onClick={() => setPeriod("today")}>
          Today{report ? ` · ${dayName(report.today)}` : ""}
        </button>
        <button className="tab" role="tab" aria-selected={period === "month"} onClick={() => setPeriod("month")}>
          This month{monthName ? ` · ${monthName}` : ""}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}

      <div className="usage-cards">
        {CARDS.map((card) => {
          const t = totalFor(rows, card.providers);
          return (
            <div key={card.key} className="usage-card">
              <span className="eyebrow">{card.title}</span>
              <strong title={`${fullNumber.format(t.input + t.output)} tokens`}>{shortNumber.format(t.input + t.output)}</strong>
              <span className="small muted">
                tokens · {fullNumber.format(t.calls)} call{t.calls === 1 ? "" : "s"}
              </span>
              <dl className="usage-card__split">
                <div>
                  <dt>Input</dt>
                  <dd>{fullNumber.format(t.input)}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>{fullNumber.format(t.output)}</dd>
                </div>
                {!card.note && (
                  <div>
                    <dt>Cached</dt>
                    <dd>{fullNumber.format(t.cached)}</dd>
                  </div>
                )}
              </dl>
              {card.note && <span className="small muted">{card.note}</span>}
            </div>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <p className="muted">No AI calls {period === "today" ? "today" : "this month"} yet.</p>
      ) : (
        <>
          <h3 className="subhead">By model</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Used for</th>
                  <th className="num">Calls</th>
                  <th className="num">Input</th>
                  <th className="num">Output</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.provider}|${r.model}|${r.feature}`}>
                    <td>{USAGE_PROVIDER_LABELS[r.provider]}</td>
                    <td>
                      <code>{r.model}</code>
                    </td>
                    <td>{FEATURE_LABELS[r.feature]}</td>
                    <td className="num">{fullNumber.format(r.calls)}</td>
                    <td className="num">{fullNumber.format(r.input)}</td>
                    <td className="num">{fullNumber.format(r.output)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {period === "month" && report && report.daily.length > 0 && (
        <>
          <h3 className="subhead">By day (input + output tokens)</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  {CARDS.map((card) => (
                    <th key={card.key} className="num">
                      {card.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.daily.map((d) => (
                  <tr key={d.day}>
                    <td>{dayName(d.day)}</td>
                    {CARDS.map((card) => (
                      <td key={card.key} className="num">
                        {fullNumber.format(card.providers.reduce((n, p) => n + (d.totals[p]?.input ?? 0) + (d.totals[p]?.output ?? 0), 0))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="small muted">
        Counted by this app from each service&apos;s own usage report, starting from when tracking was added. Cached input is billed at a lower rate.
      </p>
    </section>
  );
}
