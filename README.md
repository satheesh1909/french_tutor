# Charlotte, a personal French tutor

A voice-first French tutor that talks with you in French and English. She corrects your mistakes and explains them, runs quizzes and role-plays, and tracks your progress from **A2 → B1 → B2**.

This is **Phase 1**: the tutoring brain, voice, memory and progress tracking. The animated portrait is a placeholder for the photoreal avatar that comes in Phase 2.

## Which AI does what

| Job | Service | Why |
|---|---|---|
| Conversation, corrections, explanations | **Claude** (Opus 5) | Needs the most reliable French grammar judgement |
| End-of-session review and level estimate | **Claude** (Opus 5, high effort) | Careful assessment against CEFR descriptors |
| Hearing you (speech → text) | **Gemini** `gemini-3.5-transcribe`, verbatim mode | Keeps your mistakes in the transcript instead of silently fixing them |
| Her voice (text → speech) | **Gemini** `gemini-3.1-flash-tts-preview` | One voice: British accent in English, native accent in French |
| Written quizzes | **Gemini** `gemini-3.8-flash` | Fast, cheap question writing |
| Remembering and grouping your mistakes | **Ollama** `nomic-embed-text` (local) | Free, private, instant; spots repeat mistakes |

Everything still works if Ollama is closed. Only similar-mistake recall is turned off.

## Setup

1. Install [Node.js](https://nodejs.org) 22 or newer. You already have it.
2. Copy `.env.example` to `.env.local` and fill in:
   - `ANTHROPIC_API_KEY`: create one at [console.anthropic.com](https://console.anthropic.com). This is separate from a Claude.ai subscription.
   - `GEMINI_API_KEY`: from [Google AI Studio](https://aistudio.google.com/apikey). If `GOOGLE_API_KEY` is already set in your system environment, it's used automatically.
3. Optional: keep Ollama running with `ollama pull nomic-embed-text`.
4. Install dependencies and start the app:

   ```bash
   npm install
   npm run dev
   ```

5. Open http://localhost:3000 in Chrome or Edge and allow microphone access.

## Using it

- **Tutor**: pick an activity (Conversation, Role-play, Lesson, Oral quiz, Level check). Click **Speak** or hold **Space** to talk, or type. Corrections show under your message and, with explanations, in the right-hand panel. Press **End & review** when you're done: Claude reviews the session and updates your level, focus areas and next-session plan.
- **Practice**: spaced-repetition cards, created automatically from your mistakes and new vocabulary, plus Gemini-written quizzes aimed at your weak spots.
- **Progress**: your level estimates, mistake patterns, session history and settings (name, goals, correction style, voice).

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
  lib/srs.ts      spaced-repetition scheduling
  lib/store.ts    JSON file storage
  components/     Tutor, Practice and Progress screens, mic recorder, voice playback, avatar stage
```
