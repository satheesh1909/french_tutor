import type { z } from "zod";
import { claudeStructured } from "./providers/claude";
import { geminiStructured } from "./providers/gemini";
import { ollamaStructured } from "./providers/ollama";
import type { StructuredRequest } from "./structured";
import type { ModelChoice } from "./types";

/** Runs a JSON-returning request on whichever provider the Settings page picked for this job. */
export function generateStructured<T extends z.ZodType>(
  choice: ModelChoice,
  request: Omit<StructuredRequest<T>, "model" | "effort">,
): Promise<z.infer<T>> {
  const full: StructuredRequest<T> = { ...request, model: choice.model, effort: choice.effort };
  switch (choice.provider) {
    case "claude":
      return claudeStructured(full);
    case "gemini":
      return geminiStructured(full);
    case "ollama":
      return ollamaStructured(full);
  }
}
