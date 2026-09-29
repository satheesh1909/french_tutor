async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * A POST that answers in newline-delimited JSON, yielding each line as it arrives. Used for the
 * tutor's reply, where waiting for the last line would mean waiting to hear her at all.
 *
 * A request that fails before the stream opens still answers with a normal JSON error, so that is
 * read and thrown here exactly as `post` would.
 */
async function* postLines<T>(url: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let held = "";
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      held += decoder.decode(value, { stream: true });
      let newline = held.indexOf("\n");
      while (newline >= 0) {
        const line = held.slice(0, newline).trim();
        held = held.slice(newline + 1);
        if (line) yield JSON.parse(line) as T;
        newline = held.indexOf("\n");
      }
    }
    const last = held.trim();
    if (last) yield JSON.parse(last) as T;
  } finally {
    // Leaving the loop early (she was interrupted) must not leave the response half-read. Cancelling
    // one that already ran out shows up as a failed request in devtools, which is misleading.
    if (!drained) void reader.cancel().catch(() => undefined);
  }
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body: unknown, signal?: AbortSignal) => request<T>("POST", url, body, signal),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  postLines,
};

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
