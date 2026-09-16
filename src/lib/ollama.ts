import { config } from "./config";

// Ollama is optional. Everything that uses it has a fallback, so the tutor still works when it's closed.

/** nomic-embed-text expects task prefixes: documents are stored mistakes, queries are what the student just said. */
export async function embed(texts: string[], kind: "query" | "document"): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const res = await fetch(`${config.ollama.url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.ollama.embedModel, input: texts.map((t) => `search_${kind}: ${t}`) }),
      // Storing mistakes happens in the background and may wait for Ollama to load the model;
      // recall happens while the student waits, so it gives up quickly.
      signal: AbortSignal.timeout(kind === "document" ? 60_000 : 5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { embeddings?: number[][] };
    return data.embeddings?.length === texts.length ? data.embeddings : null;
  } catch {
    return null;
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

export async function ollamaStatus(): Promise<{ online: boolean; hasEmbedModel: boolean }> {
  try {
    const res = await fetch(`${config.ollama.url}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return { online: false, hasEmbedModel: false };
    const data = (await res.json()) as { models?: { name: string }[] };
    const hasEmbedModel = (data.models ?? []).some((m) => m.name.split(":")[0] === config.ollama.embedModel.split(":")[0]);
    return { online: true, hasEmbedModel };
  } catch {
    return { online: false, hasEmbedModel: false };
  }
}
