# Alice, a personal French tutor

A voice-first French tutor that talks with you in French and English. She corrects your mistakes and explains them, runs quizzes and role-plays, and tracks your progress from **A2 → B1 → B2**.

She speaks with a neural voice that runs on this computer, with no daily limit, and she has a face: a real photograph, lip-synced to that voice. Both are free and entirely local.

## Which AI does what

| Job | Service | Why |
|---|---|---|
| Conversation, corrections, explanations | **Claude** (Opus 5) | Needs the most reliable French grammar judgement |
| End-of-session review and level estimate | **Claude** (Opus 5, high effort) | Careful assessment against CEFR descriptors |
| Answering questions about your level | **Claude** (Progress page) | Reads every review, mistake and speed figure before answering |
| Hearing you (speech → text) | **Gemini** `gemini-3.5-transcribe`, verbatim mode | Keeps your mistakes in the transcript instead of silently fixing them |
| Her voice (text → speech) | **Piper** via `piper_server` (local, CPU) | Native French, unlimited, private, and about ten times faster than real time |
| Her voice, alternative | **XTTS-v2** via `voice_server` (local, GPU) | Keeps one voice across both languages, but takes about 2.6 seconds per second of speech here |
| Her voice, alternative | **Gemini** `gemini-3.1-flash-tts-preview` | Thirty voices to choose from, but the free tier allows about a hundred clips a day |
| Written quizzes | **Gemini** `gemini-3.8-flash` | Fast, cheap question writing |
| Remembering and grouping your mistakes | **Ollama** `nomic-embed-text` (local) | Free, private, instant; spots repeat mistakes |
| Speaking speed (word timings) | **Whisper** `medium` via faster-whisper (local, GPU) | Exact start and end time for every word; runs alongside Gemini with no extra wait |
| Her face moving as she speaks | **Wav2Lip** via `avatar_server` (local, GPU) | Lip-syncs a photo to her voice: free, private, about half a second a reply |

## Speaking speed

Every spoken answer is timed. You'll see:
- **words per minute**, pauses included
- **words per minute while talking**, with pauses left out
- **pauses** of 0.4 s or longer

The numbers appear under each spoken message, in the side panel during a session, in the session review, and on the Progress page (today, last 7 days, this month, all time).

The most precise timings come from the local Whisper server. If it isn't running, speed is estimated from when your recording is loud enough to be speech.

Whisper can also do all the transcription (Settings → Speech to text). That mode is free and offline, but Whisper tends to tidy small slips (e.g. "que il" becomes "qu'il") and handles one language per recording, so Gemini remains the default for the words.

Everything still works if Ollama is closed. Only similar-mistake recall is turned off.

These are the defaults. On the **Settings** page you can:

- choose Claude, Gemini or a local Ollama model for the tutor, the session review, the quiz writer and the level coach, including the model and, for Claude, the effort level
- pick the transcription model and the local embedding model, or turn mistake memory off
- choose the voice: Gemini's 30 voices are grouped by the pitch we measured from a sample of each one (higher ones usually read as female, lower as male) and every one has a play button, or use your computer's own voices. The Tutor page has the same picker with a **Hear** button. Whichever you choose, she is asked to speak British English and native-sounding French.
- paste your Claude and Gemini API keys straight into **Connections**; each is tested as you save it and takes effect without a restart
- choose her face: photo, 3D head or a plain circle
- set how long a pause ends your turn, the microphone sensitivity, and whether talking over the tutor interrupts her
- see token usage for today and this month, split into Local LLM, Gemini and Claude, with a breakdown by model and job

Small local models are free and private but unreliable for grammar. In testing, `qwen2.5:7b` returned empty replies and `llama3:8b` gave wrong corrections. Use them for casual practice only.

## Her voice

Her voice is the thing you actually use, so it should never run out and it should never keep you waiting. Four choices, on the **Settings** page:

- **Local, instant** (the one to use): Piper on your CPU. Free, offline, no limit, and it renders a reply about **ten times faster than real time** — a fourteen-second answer is ready in under a second and a half. Its French voices are French, so the accent is native. The catch is that each Piper model knows one language, so she uses two voices and audibly becomes a different person when she breaks off to explain something in English.
- **Local, one voice**: XTTS-v2 on your GPU. One voice covers both languages, so she stays the same person throughout, and it is also free and unlimited. But it is slow here: measured on an RTX 5070 Laptop it needs about **2.6 seconds of work for every second of speech**, so a typical reply takes roughly twenty seconds before she starts talking. The GPU sits at about 11% while it does this — XTTS generates one token at a time, and the per-token overhead, not the arithmetic, is the limit. Worth it if a single voice matters more to you than the wait.
- **Gemini voice**: thirty voices, very natural, grouped by the pitch we measured from each. The free tier allows roughly a hundred clips a day, and when that runs out she falls back to the browser voice until it resets.
- **Browser voice**: whatever is installed on this computer. Instant and free, but French and English come from two different speakers anyway, and the quality depends on your Windows voices.

Whichever you pick, a clip is only ever made once: everything she says is cached in `data/speech-cache`, so a repeated phrase is free and instant. If the chosen voice fails mid-lesson, she carries on with the browser voice rather than going silent.

### Setting up the instant voice (Piper)

About 450 MB and a couple of minutes. No GPU needed.

```bash
powershell -ExecutionPolicy Bypass -File .\piper_server\setup.ps1
```

That makes a small Python environment — Piper needs onnxruntime, not PyTorch — and fetches three French and three English voices. Then `npm run piper` starts the server, and `start-tutor.cmd` starts it along with everything else.

To add voices, drop an `.onnx` and `.onnx.json` pair into `piper_server/voices` and restart the server; they appear in Settings. There are well over a hundred at [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). A file containing several speakers is listed once per speaker.

She speaks French at 92% of the voice's own pace, which is a little easier to follow; change that with `PIPER_FR_SPEED`.

### Setting up the one-voice alternative (XTTS)

About 4 GB of downloads and 15–30 minutes, most of it PyTorch. You need an NVIDIA GPU and Python 3.11 or 3.12.

```bash
powershell -ExecutionPolicy Bypass -File .\voice_server\setup.ps1
```

It shows you the model's licence and asks you to accept it — XTTS-v2 is released under the [Coqui Public Model License](https://coqui.ai/cpml), which permits personal, non-commercial use only. Then it makes a private Python environment, installs XTTS and fetches the model. `npm run voice` starts it.

**The accent.** The speakers that ship with XTTS are mostly English actors, so their French is fluent but carries a slight accent. For a native accent, put a clear ten-second wav of a French speaker into `voice_server/voices`, restart the server, and choose it in Settings: she imitates it. Use your own voice, or a public-domain or Creative Commons recording — never somebody else's voice without their permission.

If both are installed, `start-tutor.cmd` starts only Piper, so XTTS isn't holding 2.5 GB of VRAM for a voice she isn't using. Run `npm run voice` by hand when you want it.

## Her face

Three choices, on the **Settings** page:

- **Photo** (the good one): a real photograph of her, with the mouth re-rendered from her own voice, on your GPU. Free, nothing leaves the machine, and it adds roughly half a second to a reply. Needs the one-off setup below.
- **3D head**: a head sculpted in the browser, with a jaw that follows her voice, blinks and glances. No setup, works everywhere, but it looks like a cartoon.
- **Simple**: the plain circle, if you'd rather have no motion.

### Setting up the photo avatar

About 6 GB of downloads and half an hour, most of it PyTorch. You need an NVIDIA GPU and Python 3.11 or 3.12.

```bash
powershell -ExecutionPolicy Bypass -File .\avatar_server\setup.ps1
```

That makes a private Python environment, fetches Wav2Lip and its weights, patches it for current libraries, and checks your GPU. Then `npm run avatar` starts the server (about a minute to warm up: the first frame batch on this GPU compiles kernels, and every batch after it takes a fifth of a second).

To change her face, drop a front-facing portrait into `avatar_server/faces` and restart the server; pick it in Settings. Use a generated or licensed face, never a real person's photo without their permission. A picker in the app is coming later.

**What it is and isn't.** The face is photoreal and the timing is right, but the mouth is softer than the rest of the picture, because Wav2Lip generates it small and scales it up. At the size she's drawn, it reads well. Her head doesn't move and she doesn't blink, so she is a photograph that talks, not a person on a video call.

## Setup

1. Install [Node.js](https://nodejs.org) 22 or newer. You already have it.
2. Get your API keys. Easiest: start the app and paste them into **Settings → Connections**, where each key is checked as you save it and kept in `data/secrets.json` on this computer.
   - Claude, from [console.anthropic.com](https://console.anthropic.com). This is separate from a Claude.ai subscription.
   - Gemini, from [Google AI Studio](https://aistudio.google.com/apikey).

   If you prefer files, copy `.env.example` to `.env.local` and set `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` there instead; a key saved in the app wins over the file.
3. Optional: keep Ollama running with `ollama pull nomic-embed-text`.
4. Optional, for precise speaking speed: Python with `pip install faster-whisper` (an NVIDIA GPU makes it fast).
5. Optional, for a voice with no daily limit: run `piper_server/setup.ps1` (see **Her voice** above).
6. Optional, for her face to move: run `avatar_server/setup.ps1` (see **Her face** above).
7. Install dependencies and start everything by double-clicking **`start-tutor.cmd`**.

   It installs what's missing, builds the app when the code has changed, starts Whisper, her voice and the avatar in the background, waits for the app to answer, and opens it in its own window. **`stop-tutor.cmd`** stops it all. Run **`Create desktop shortcut.cmd`** once and you get a "French Tutor" icon on the desktop and in the Start menu.

   To run the pieces by hand instead: `npm run dev`, `npm run whisper`, `npm run piper` (or `npm run voice`), `npm run avatar`.

## Using it

- **Tutor**: pick an activity (Conversation, Role-play, Lesson, Oral quiz, Level check). Role-plays come in two groups: everyday life (café, doctor, flat hunting) and the office (first day, coffee break, stand-up, one-to-one, slipping a deadline, client call, explaining a process, presenting a project, disagreeing with a colleague, appraisal, negotiating with a supplier, interview, remote-work debate). Choose **Describe a situation…** to role-play anything else in your own words, and use the text box to add detail such as your job or the client's name. In **hands-free** mode (on by default) the microphone stays open: just talk, and your answer is sent after a pause of about two seconds. Talking while she speaks stops her; carrying on after a pause merges both parts into one answer. The bar next to the microphone shows what the app hears, **Send now** skips the wait, and **Pause** stops listening. Turn hands-free off to use the **Speak** button or hold **Space** instead, or just type. Corrections show under your message and, with explanations, in the right-hand panel. Press **End & review** when you're done: Claude reviews the session and updates your level, focus areas and next-session plan.
- **Practice**: spaced-repetition cards, created automatically from your mistakes and new vocabulary, plus Gemini-written quizzes aimed at your weak spots.
- **Progress**: your level estimates, mistake patterns, session history and settings (name, goals, correction style, voice). **Ask about your level** puts your questions to a DELF examiner who has read every session review, every logged mistake and your measured speaking speed: "what is stopping me reaching B1?", "how did my last level check go?". Answers quote the evidence, and where a drill would help you get a one-click **Quiz me on...** button. You can also ask for a quiz on any point you name.

Start with a **Level check** session so the tutor calibrates to you.

## Your data

Everything is stored as JSON in `./data` on your computer (git-ignored): your profile, sessions, mistakes and review cards. Delete the folder to start fresh.

**Corrections are only saved when you press End & review.** During a session the tutor's corrections appear on screen straight away, but nothing goes into your mistake history or your review deck until the end-of-session review has looked at each one and confirmed it. A session you walk away from records no mistakes, and that is deliberate: an unverified correction is worse than none, because a wrong one gets drilled as a flashcard for weeks. The review marks each correction confirmed, amended or wrong, and only the first two are kept.

**A short session can't change your level.** Under 150 words or fewer than 4 turns, the review still writes its advice, plan and encouragement, but your CEFR estimates stay where they were. The Progress page says so on any session where this applied.

## Roadmap

- **Phase 2: realistic avatar.** A streaming video avatar service (e.g. HeyGen, Tavus, Simli, Anam) replaces the portrait in `src/components/AvatarStage.tsx`, driven by the same speech and state.
- **Phase 3:** pronunciation scoring, DELF-style mock exams, streaming replies for lower latency.

## Project layout

```
src/
  app/api/        server routes: session, tutor, transcribe, tts, quiz, practice, progress, profile, health
  lib/claude.ts   tutor turns and session reviews (structured output)
  lib/gemini.ts   transcription, voice, quiz generation
  lib/ollama.ts   local embeddings
  lib/learner.ts  mistake history, similar-mistake recall, review-card creation
  lib/prompts.ts  all prompts
  lib/types.ts    shared types, the activity list and the role-play scenarios (add your own here)
  lib/srs.ts      spaced-repetition scheduling
  lib/store.ts    JSON file storage
  components/     Tutor, Practice and Progress screens, mic recorder, voice playback, avatar stage
whisper_server/   local speech-to-text with word timings
piper_server/     the quick local voice: server.py, setup.ps1, and the models in voices/
voice_server/     the one-voice local alternative (XTTS): server.py, setup.ps1, recordings in voices/
avatar_server/    local lip-sync: server.py, setup.ps1, and the photos in faces/
```
