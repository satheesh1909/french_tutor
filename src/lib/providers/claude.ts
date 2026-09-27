import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { UserFacingError } from "../http";
import type { StructuredRequest } from "../structured";
import { EFFORTS, nearestEffort, type Effort } from "../types";
import { claudeKey, claudeWorkspaceId } from "../store";
import { recordUsage } from "../usage";

// Created lazily so routes that don't need Claude still load when no key is configured, and
// rebuilt when the key changes (the Settings page can save a new one at any time).
let client: Anthropic | undefined;
let clientKey: string | undefined;

async function claude(): Promise<Anthropic> {
  const [key, workspace] = await Promise.all([claudeKey(), claudeWorkspaceId()]);
  if (!key && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new UserFacingError("No Claude API key yet. Add one on the Settings page, under Connections.", 400);
  }
  // The workspace is part of what identifies the caller, so a change to it rebuilds the client
  // just as a change of key does.
  const identity = `${key ?? ""}|${workspace ?? ""}`;
  if (!client || clientKey !== identity) {
    client = new Anthropic({
      ...(key ? { apiKey: key } : {}),
      ...(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {}),
    });
    clientKey = identity;
  }
  return client;
}

export const hasClaudeCredentials = async () => Boolean((await claudeKey()) || process.env.ANTHROPIC_AUTH_TOKEN);

/**
 * Claude Opus 5 can decline a request; "default" fallbacks re-run a declined request server-side
 * on Anthropic's recommended model instead of failing the turn. Other models don't take the parameter.
 */
function fallbacks(model: string) {
  return /^claude-(opus-5|fable-5)/.test(model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
}

export interface ClaudeModelInfo {
  id: string;
  label: string;
  /** Effort levels the model accepts; empty when it doesn't take the effort parameter at all (e.g. Haiku 4.5). */
  efforts: Effort[];
  structuredOutputs: boolean;
  maxOutputTokens: number | null;
}

function describeModel(m: Anthropic.ModelInfo): ClaudeModelInfo {
  const effort = m.capabilities?.effort;
  return {
    id: m.id,
    label: m.display_name,
    efforts: effort?.supported ? EFFORTS.filter((level) => effort[level]?.supported) : [],
    structuredOutputs: m.capabilities?.structured_outputs.supported ?? true,
    maxOutputTokens: m.max_tokens,
  };
}

// Model capabilities don't change during a run, so look each one up once.
const modelInfoCache = new Map<string, Promise<ClaudeModelInfo | null>>();

function modelInfo(id: string): Promise<ClaudeModelInfo | null> {
  const cached = modelInfoCache.get(id);
  if (cached) return cached;
  const info = claude()
    .then((c) => c.models.retrieve(id))
    .then(describeModel)
    .catch(() => {
      modelInfoCache.delete(id); // try again next time
      return null;
    });
  modelInfoCache.set(id, info);
  return info;
}

export async function claudeStructured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
  // If the lookup fails, send the request as configured and let the API report any problem.
  const info = await modelInfo(req.model);
  if (info && !info.structuredOutputs) {
    throw new UserFacingError(`${info.label} can't return the structured answers the tutor needs. Choose a newer Claude model in Settings.`, 400);
  }
  // Models without the effort parameter (e.g. Haiku 4.5) reject it outright, so leave it out for them.
  const effort = info ? nearestEffort(req.effort, info.efforts) : req.effort;

  // Streaming so a long, high-effort answer can't hit an HTTP timeout.
  const stream = (await claude()).beta.messages.stream({
    model: req.model,
    max_tokens: Math.min(64000, info?.maxOutputTokens ?? 64000),
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    // Every turn is replayed exactly as first sent, so the growing history stays cacheable.
    messages: req.messages.map(
      (m): Anthropic.Beta.BetaMessageParam =>
        m.role === "assistant"
          ? { role: "assistant", content: m.parts.join("\n\n") }
          : { role: "user", content: m.parts.map((text) => ({ type: "text" as const, text })) },
    ),
    cache_control: { type: "ephemeral" },
    output_config: { ...(effort ? { effort } : {}), format: betaZodOutputFormat(req.schema) },
    ...fallbacks(req.model),
  }, { signal: req.signal });
  const response = await stream.finalMessage();

  const u = response.usage;
  const cached = u.cache_read_input_tokens ?? 0;
  recordUsage({
    provider: "claude",
    model: req.model,
    feature: req.feature,
    input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cached,
    cached,
    output: u.output_tokens,
  });

  if (response.stop_reason === "refusal") {
    throw new UserFacingError("Claude declined to answer that. Try rephrasing.", 422);
  }
  if (!response.parsed_output) {
    throw new Error(`Claude's reply couldn't be read (stop reason: ${response.stop_reason}).`);
  }
  return response.parsed_output as z.infer<T>;
}

export async function listClaudeModels(): Promise<ClaudeModelInfo[]> {
  if (!hasClaudeCredentials()) return [];
  const models: ClaudeModelInfo[] = [];
  for await (const m of (await claude()).models.list({ limit: 100 })) {
    const info = describeModel(m);
    modelInfoCache.set(m.id, Promise.resolve(info));
    models.push(info);
  }
  return models;
}
