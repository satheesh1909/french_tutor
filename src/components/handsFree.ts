"use client";

import type { MicSensitivity } from "@/lib/types";
import { concatAudio, rmsOf } from "./audioClip";
import type { LevelRef } from "./voice";

// Hands-free listening: the microphone stays open, and speech is detected from its loudness
// compared with the room's background level. A turn ends after a long enough silence.

// Collects microphone samples off the main thread and hands them over in ~20 ms blocks.
const WORKLET_SOURCE = `
class MicTap extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(1024); this.filled = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      let i = 0;
      while (i < input.length) {
        const n = Math.min(input.length - i, this.block.length - this.filled);
        this.block.set(input.subarray(i, i + n), this.filled);
        this.filled += n;
        i += n;
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("mic-tap", MicTap);
`;

const SENSITIVITY: Record<MicSensitivity, { factor: number; minimum: number }> = {
  low: { factor: 4, minimum: 0.015 },
  medium: { factor: 3, minimum: 0.011 },
  high: { factor: 2.2, minimum: 0.007 },
};

const PREROLL_SEC = 0.4; // kept from just before speech starts, so the first syllable isn't lost
const START_SEC = 0.15; // this much continuous speech starts a turn
const START_SEC_OVER_TUTOR = 0.35; // stricter while the tutor talks, so her voice isn't mistaken for yours
const OVER_TUTOR_LOUDNESS = 2; // and louder, too
const TAIL_SEC = 0.35; // silence kept at the end of a turn
const MIN_VOICED_SEC = 0.3; // shorter bursts (a cough, a click) are ignored
const MAX_TURN_SEC = 90;
const CALIBRATION_SEC = 0.5;

/** Live view of what the microphone hears, for the on-screen meter. */
export interface MicMeter {
  level: number;
  threshold: number;
  speaking: boolean;
  /** Seconds of silence so far; the turn ends when this reaches the chosen pause. */
  silenceSec: number;
}

export interface ListenerOptions {
  endSilenceMs: number;
  sensitivity: MicSensitivity;
  level: LevelRef;
  meter?: MicMeter;
  onSpeechStart: () => void;
  onUtterance: (samples: Float32Array, sampleRate: number) => void;
  /** Speech started but turned out too short to be a real turn. */
  onDiscard: () => void;
}

export class VoiceActivityListener {
  /** Set while the tutor is talking; speech then has to be louder and longer to count. */
  tutorSpeaking = false;
  /** When false, nothing is detected while the tutor is talking. */
  allowInterrupt = true;
  /** Temporarily ignore the microphone (e.g. the student muted it). */
  paused = false;

  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  /** Background level of the room, updated continuously (including while the student talks). */
  private floor = 0.002;
  /** How loud the current turn has been; the end of a turn is judged against this too. */
  private peak = 0;
  private calibratedSec = 0;
  private sampleRate = 48_000;
  private speaking = false;
  private preroll: Float32Array[] = [];
  private prerollSec = 0;
  private turn: Float32Array[] = [];
  private turnSec = 0;
  private loudSec = 0;
  private silenceSec = 0;
  private voicedSec = 0;

  constructor(private options: ListenerOptions) {}

  update(changes: Partial<Pick<ListenerOptions, "endSilenceMs" | "sensitivity">>) {
    Object.assign(this.options, changes);
  }

  async start(): Promise<void> {
    // Automatic gain is off on purpose: it raises the volume of silence, which hides the pause
    // that ends a turn.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    const ctx = new AudioContext();
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, "mic-tap");
    // The tap must be connected to the output to keep running; a zero gain keeps it silent.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(this.node);
    this.node.connect(silent);
    silent.connect(ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onBlock(e.data, ctx.sampleRate);
    if (ctx.state !== "running") await ctx.resume();
  }

  stop() {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.reset();
    this.options.level.current = 0;
  }

  private reset() {
    this.speaking = false;
    this.turn = [];
    this.turnSec = 0;
    this.loudSec = 0;
    this.silenceSec = 0;
    this.voicedSec = 0;
  }

  /** Ends the current turn straight away (the "Send now" button). */
  finishNow() {
    if (this.speaking) this.finishTurn(this.sampleRate);
  }

  private onBlock(block: Float32Array, sampleRate: number) {
    this.sampleRate = sampleRate;
    const sec = block.length / sampleRate;
    const level = rmsOf(block);
    this.learnBackground(level, sec);

    const { factor, minimum } = SENSITIVITY[this.options.sensitivity];
    const overTutor = this.tutorSpeaking;
    const startThreshold = Math.max(this.floor * factor, minimum) * (overTutor ? OVER_TUTOR_LOUDNESS : 1);
    // Ending a turn is judged against how loud this turn has been as well as the background, so a
    // noisy room or a quiet microphone can't keep a turn open forever.
    const endThreshold = this.speaking ? Math.max(this.floor * 1.8, this.peak * 0.12, minimum * 0.6) : startThreshold;
    const threshold = this.speaking ? endThreshold : startThreshold;
    if (this.options.meter) {
      this.options.meter.level = level;
      this.options.meter.threshold = threshold;
      this.options.meter.speaking = this.speaking;
      this.options.meter.silenceSec = this.speaking ? this.silenceSec : 0;
    }

    if (!this.speaking) {
      this.preroll.push(block);
      this.prerollSec += sec;
      while (this.preroll.length > 1 && this.prerollSec - this.preroll[0].length / sampleRate >= PREROLL_SEC) {
        this.prerollSec -= this.preroll.shift()!.length / sampleRate;
      }
      if (this.paused || this.calibratedSec < CALIBRATION_SEC || (overTutor && !this.allowInterrupt)) {
        this.loudSec = 0;
        return;
      }
      this.loudSec = level > startThreshold ? this.loudSec + sec : 0;
      if (this.loudSec >= (overTutor ? START_SEC_OVER_TUTOR : START_SEC)) {
        this.speaking = true;
        this.peak = Math.max(level, startThreshold * 1.5);
        this.turn = this.preroll;
        this.turnSec = this.prerollSec;
        this.voicedSec = this.loudSec;
        this.preroll = [];
        this.prerollSec = 0;
        this.options.onSpeechStart();
      }
      return;
    }

    if (this.paused) {
      this.reset();
      this.options.level.current = 0;
      return;
    }
    this.turn.push(block);
    this.turnSec += sec;
    this.options.level.current = Math.min(1, level * 8);
    this.peak = Math.max(this.peak * 0.995, level); // follows the voice, fades between phrases
    if (level > endThreshold) {
      this.silenceSec = 0;
      this.voicedSec += sec;
    } else {
      this.silenceSec += sec;
    }
    if (this.silenceSec * 1000 >= this.options.endSilenceMs || this.turnSec >= MAX_TURN_SEC) this.finishTurn(sampleRate);
  }

  /**
   * Tracks the room's background level. It follows quiet moments quickly and rises only very
   * slowly, so it keeps working while the student is talking — that's what lets a turn end.
   */
  private learnBackground(level: number, sec: number) {
    if (this.calibratedSec < CALIBRATION_SEC) {
      const n = this.calibratedSec / sec;
      this.floor = (this.floor * n + level) / (n + 1);
      this.calibratedSec += sec;
    } else if (level < this.floor) {
      this.floor = this.floor * 0.85 + level * 0.15;
    } else {
      this.floor = this.floor * 0.999 + level * 0.001;
    }
    this.floor = Math.min(Math.max(this.floor, 0.0005), 0.05);
  }

  private finishTurn(sampleRate: number) {
    const samples = concatAudio(this.turn);
    const dropSec = Math.max(0, this.silenceSec - TAIL_SEC);
    const trimmed = samples.subarray(0, Math.max(0, samples.length - Math.floor(dropSec * sampleRate)));
    const voiced = this.voicedSec;
    this.reset();
    this.options.level.current = 0;
    if (voiced < MIN_VOICED_SEC) this.options.onDiscard();
    else this.options.onUtterance(trimmed, sampleRate);
  }
}
