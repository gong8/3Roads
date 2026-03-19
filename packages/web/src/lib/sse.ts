export interface SSEEvent {
  event: string;
  data: string;
}

export async function* streamSSE(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new Error(`Stream error ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7);
        } else if (trimmed.startsWith("data: ")) {
          yield { event: currentEvent, data: trimmed.slice(6) };
          currentEvent = "message";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
