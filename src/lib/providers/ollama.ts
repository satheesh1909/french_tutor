import type { z } from "zod";
import { config } from "../config";
import { UserFacingError } from "../http";
import { readSettings } from "../store";
import { jsonSchemaFor, type StructuredRequest } from "../structured";
import type { OllamaModelInfo } from "../types";
import { recordUsage } from "../usage";

// Ollama is optional. Mistake memory falls back gracefully when it's closed; a job explicitly
// assigned to a local model reports a clear error instead.

const url = (path: string) => `${config.ollama.url}${path}`;

/**
 * How long Ollama keeps the embedding model in memory after a request. Its own default is five
 * minutes, which a thinking pause can outlast - and reloading costs about two seconds, paid inside
 * the student's wait. The model is 274 MB, so keeping it resident through a session is cheap.
 */
const EMBED_KEEP_ALIVE = "30m";

/** nomic-embed-text expects task prefixes: documents are stored mistakes, queries are what the student just said. */
export async function embed(texts: string[], kind: "query" | "document"): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const { memory } = await readSettings();
  if (!memory.enabled) return null;
  try {
    const res = await fetch(url("/api/embed"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: memory.model, input: texts.map((t) => `search_${kind}: ${t}`), keep_alive: EMBED_KEEP_ALIVE }),
      // Storing mistakes happens in the background and may wait for Ollama to load the model;
      // recall happens while the student waits, so it gives up quickly.
      signal: AbortSignal.timeout(kind === "document" ? 60_000 : 5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][]; prompt_eval_count?: number };
    recordUsage({ provider: "ollama", model: memory.model, feature: "memory", input: data.prompt_eval_count ?? 0 });
    return data.embeddings?.length === texts.length ? data.embeddings : null;
  } catch {
    return null;
  }
}

/**
 * Loads the embedding model before anyone needs it. Recall runs while the student waits for an
 * answer, so a cold Ollama put its whole two-second load inside the first reply of every session.
 * The page asks for health when it opens, which is the one moment nobody is waiting.
 *
 * Returns false when there is nothing to warm (memory off, Ollama closed) or the load failed; the
 * caller only logs it, because a cold embedder costs a slow turn, not a broken one.
 */
export async function embedWarm(): Promise<boolean> {
  const { memory } = await readSettings();
  if (!memory.enabled) return false;
  try {
    const res = await fetch(url("/api/embed"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // One short query, purely to make Ollama load the model and hold it.
      body: JSON.stringify({ model: memory.model, input: "search_query: bonjour", keep_alive: EMBED_KEEP_ALIVE }),
      signal: AbortSignal.timeout(120_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function ollamaStructured<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
  const info = (await listOllamaModels().catch(() => [])).find((m) => m.name === req.model);
  const schema = jsonSchemaFor(req.schema);
  // Small models fill the required shape with empty values unless the prompt spells it out too.
  const system = `${req.system}\n\nAnswer with one JSON object that follows this JSON Schema, filling every field with real content:\n${JSON.stringify(schema)}`;
  let res: Response;
  try {
    res = await fetch(url("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        stream: false,
        format: schema,
        messages: [{ role: "system", content: system }, ...req.messages.map((m) => ({ role: m.role, content: m.parts.join("\n\n") }))],
        // Thinking models ramble for thousands of tokens; a conversation needs a quick answer.
        ...(info?.capabilities.includes("thinking") ? { think: false } : {}),
        options: { temperature: 0.4, num_ctx: 8192 },
      }),
      signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    throw new UserFacingError(`The local model "${req.model}" isn't reachable. Is Ollama running?`, 503);
  }
  if (!res.ok) throw new UserFacingError(`The local model "${req.model}" failed: ${await res.text()}`, 502);

  const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  recordUsage({ provider: "ollama", model: req.model, feature: req.feature, input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0 });
  try {
    return req.schema.parse(JSON.parse(data.message?.content ?? "")) as z.infer<T>;
  } catch {
    throw new UserFacingError(`The local model "${req.model}" gave an answer the app couldn't read. Try again or pick a larger model.`, 502);
  }
}

// Model details rarely change; cache them briefly so each tutor turn doesn't re-query Ollama.
let cachedModels: { at: number; models: OllamaModelInfo[] } | undefined;

export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  if (cachedModels && Date.now() - cachedModels.at < 60_000) return cachedModels.models;
  const res = await fetch(url("/api/tags"), { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const tags = (await res.json()) as { models?: { name: string; size: number; details?: { parameter_size?: string } }[] };
  const models = await Promise.all(
    (tags.models ?? []).map(async (m): Promise<OllamaModelInfo> => {
      type Show = { capabilities?: string[] };
      const show: Show = await fetch(url("/api/show"), { method: "POST", body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(3_000) })
        .then((r) => (r.ok ? (r.json() as Promise<Show>) : {}))
        .catch(() => ({}));
      return {
        name: m.name,
        parameterSize: m.details?.parameter_size ?? "",
        sizeGb: Math.round((m.size / 1024 ** 3) * 10) / 10,
        capabilities: show.capabilities ?? (m.name.includes("embed") ? ["embedding"] : ["completion"]),
      };
    }),
  );
  cachedModels = { at: Date.now(), models };
  return models;
}

export async function ollamaStatus(): Promise<{ online: boolean; hasEmbedModel: boolean }> {
  try {
    const [models, { memory }] = await Promise.all([listOllamaModels(), readSettings()]);
    return { online: true, hasEmbedModel: models.some((m) => m.name === memory.model || m.name === `${memory.model}:latest`) };
  } catch {
    return { online: false, hasEmbedModel: false };
  }
}
