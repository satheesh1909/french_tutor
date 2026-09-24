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
}

/** Plain JSON Schema for Gemini and Ollama, which don't want the "$schema" header. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
