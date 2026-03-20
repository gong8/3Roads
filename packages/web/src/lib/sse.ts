export interface SSEEvent {
  event: string;
  data: string;
}

export async function* streamSSE(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  console.log("[3roads:sse]", "connecting:", url, "body:", JSON.stringify(body));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  console.log("[3roads:sse]", "response status:", res.status, res.statusText);

  if (!res.ok) {
    console.error("[3roads:sse]", "stream request failed:", res.status, res.statusText);
    throw new Error(`Stream error ${res.status}`);
  }
  if (!res.body) {
    console.error("[3roads:sse]", "no response body on status", res.status);
    throw new Error("No response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let eventCount = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("[3roads:sse]", "stream ended normally after", eventCount, "events");
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7);
        } else if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          eventCount++;
          const truncated = data.length > 200 ? data.slice(0, 200) + "..." : data;
          console.log("[3roads:sse]", `event #${eventCount}:`, currentEvent, "data:", truncated);
          yield { event: currentEvent, data };
          currentEvent = "message";
        }
      }
    }
  } catch (err) {
    console.error("[3roads:sse]", "error during streaming:", (err as Error).name, (err as Error).message, err);
    throw err;
  } finally {
    reader.releaseLock();
  }
}
