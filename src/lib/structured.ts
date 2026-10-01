import { z } from "zod";
import type { Effort, UsageFeature } from "./types";

/** A provider-neutral chat message. User turns keep their parts separate so Claude can cache them. */
export interface ChatMessage {
  role: "user" | "assistant";
  parts: string[];
}

export interface StructuredRequest<T extends z.ZodType> {
  feature: UsageFeature;
  model: string;
  effort: Effort;
  system: string;
  messages: ChatMessage[];
  schema: T;
  /** Cancels the call (and stops spending tokens) when the student interrupts. */
  signal?: AbortSignal;
  /**
   * Called with each piece of the answer as it arrives, so a caller that can start work on a partial
   * answer doesn't have to wait for the whole thing. The text is the raw JSON being written, in
   * order. Providers that can't stream simply never call it, and the caller still gets the finished
   * answer as usual - so nothing depends on this being called.
   */
  onDelta?: (text: string) => void;
}

/** Plain JSON Schema for Gemini and Ollama, which don't want the "$schema" header. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
