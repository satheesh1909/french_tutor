# Alice, a personal French tutor

A voice-first French tutor that talks with you in French and English. She corrects your mistakes and explains them, runs quizzes and role-plays, and tracks your progress from **A2 → B1 → B2**.

This is **Phase 1**: the tutoring brain, voice, memory and progress tracking. The animated portrait is a placeholder for the photoreal avatar that comes in Phase 2.

## Which AI does what

| Job | Service | Why |
|---|---|---|
| Conversation, corrections, explanations | **Claude** (Opus 5) | Needs the most reliable French grammar judgement |
| End-of-session review and level estimate | **Claude** (Opus 5, high effort) | Careful assessment against CEFR descriptors |
| Answering questions about your level | **Claude** (Progress page) | Reads every review, mistake and speed figure before answering |
| Hearing you (speech → text) | **Gemini** `gemini-3.5-transcribe`, verbatim mode | Keeps your mistakes in the transcript instead of silently fixing them |
| Her voice (text → speech) | **Gemini** `gemini-3.1-flash-tts-preview` | One voice: British accent in English, native accent in French |
| Written quizzes | **Gemini** `gemini-3.8-flash` | Fast, cheap question writing |
| Remembering and grouping your mistakes | **Ollama** `nomic-embed-text` (local) | Free, private, instant; spots repeat mistakes |
| Speaking speed (word timings) | **Whisper** `medium` via faster-whisper (local, GPU) | Exact start and end time for every word; runs alongside Gemini with no extra wait |

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
- choose the voice: press play on any of Gemini's 30 voices to hear it before choosing, or use your computer's own voices (the Tutor page also has a quick voice picker with a **Hear** button)
- set how long a pause ends your turn, the microphone sensitivity, and whether talking over the tutor interrupts her
- see token usage for today and this month, split into Local LLM, Gemini and Claude, with a breakdown by model and job

Small local models are free and private but unreliable for grammar. In testing, `qwen2.5:7b` returned empty replies and `llama3:8b` gave wrong corrections. Use them for casual practice only.

## Setup

1. Install [Node.js](https://nodejs.org) 22 or newer. You already have it.
2. Copy `.env.example` to `.env.local` and fill in:
   - `ANTHROPIC_API_KEY`: create one at [console.anthropic.com](https://console.anthropic.com). This is separate from a Claude.ai subscription.
   - `GEMINI_API_KEY`: from [Google AI Studio](https://aistudio.google.com/apikey). If `GOOGLE_API_KEY` is already set in your system environment, it's used automatically.
3. Optional: keep Ollama running with `ollama pull nomic-embed-text`.
4. Optional, for precise speaking speed: Python with `pip install faster-whisper` (an NVIDIA GPU makes it fast).
5. Install dependencies, then start everything:

   ```bash
   npm install
   powershell -ExecutionPolicy Bypass -File .\start-tutor.ps1
   ```

   This starts Whisper in its own minimised window and the app in the current one. To start them separately instead, run `npm run whisper` in one terminal and `npm run dev` in another. The first Whisper start takes up to a minute.

6. Open http://localhost:3000 in Chrome or Edge and allow microphone access.

## Using it

- **Tutor**: pick an activity (Conversation, Role-play, Lesson, Oral quiz, Level check). Role-plays come in two groups: everyday life (café, doctor, flat hunting) and the office (first day, coffee break, stand-up, one-to-one, slipping a deadline, client call, explaining a process, presenting a project, disagreeing with a colleague, appraisal, negotiating with a supplier, interview, remote-work debate). Choose **Describe a situation…** to role-play anything else in your own words, and use the text box to add detail such as your job or the client's name. In **hands-free** mode (on by default) the microphone stays open: just talk, and your answer is sent after a pause of about two seconds. Talking while she speaks stops her; carrying on after a pause merges both parts into one answer. The bar next to the microphone shows what the app hears, **Send now** skips the wait, and **Pause** stops listening. Turn hands-free off to use the **Speak** button or hold **Space** instead, or just type. Corrections show under your message and, with explanations, in the right-hand panel. Press **End & review** when you're done: Claude reviews the session and updates your level, focus areas and next-session plan.
- **Practice**: spaced-repetition cards, created automatically from your mistakes and new vocabulary, plus Gemini-written quizzes aimed at your weak spots.
- **Progress**: your level estimates, mistake patterns, session history and settings (name, goals, correction style, voice). **Ask about your level** puts your questions to a DELF examiner who has read every session review, every logged mistake and your measured speaking speed: "what is stopping me reaching B1?", "how did my last level check go?". Answers quote the evidence, and where a drill would help you get a one-click **Quiz me on...** button. You can also ask for a quiz on any point you name.

Start with a **Level check** session so the tutor calibrates to you.

## Your data

Everything is stored as JSON in `./data` on your computer (git-ignored): your profile, sessions, mistakes and review cards. Delete the folder to start fresh.

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
```
