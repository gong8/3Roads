import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { streamSSE } from "../lib/sse";

interface StreamEvent {
  type: "content" | "tool_call_start" | "tool_call_args" | "tool_result" | "done" | "error" | "set_created";
  data: unknown;
}

interface GenerationState {
  isStreaming: boolean;
  content: string;
  events: StreamEvent[];
  setId: string | null;
  error: string | null;
}

export function useGenerationStream() {
  const [state, setState] = useState<GenerationState>({
    isStreaming: false,
    content: "",
    events: [],
    setId: null,
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const qc = useQueryClient();

  const generate = useCallback(async (theme: string, tossupCount: number, bonusCount: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ isStreaming: true, content: "", events: [], setId: null, error: null });

    try {
      for await (const { event, data } of streamSSE("/api/generate/stream", { theme, tossupCount, bonusCount }, controller.signal)) {
        if (event === "done") break;

        if (event === "error") {
          setState((s) => ({ ...s, error: data, isStreaming: false }));
          break;
        }

        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { parsed = data; }

        setState((s) => {
          const newState = { ...s, events: [...s.events, { type: event as StreamEvent["type"], data: parsed }] };
          if (event === "content" && typeof parsed === "object" && parsed !== null && "content" in parsed) {
            newState.content = s.content + (parsed as { content: string }).content;
          }
          if (event === "set_created" && typeof parsed === "object" && parsed !== null && "setId" in parsed) {
            newState.setId = (parsed as { setId: string }).setId;
          }
          return newState;
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setState((s) => ({ ...s, error: (err as Error).message }));
      }
    } finally {
      setState((s) => ({ ...s, isStreaming: false }));
      qc.invalidateQueries({ queryKey: ["sets"] });
      abortRef.current = null;
    }
  }, [qc]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { ...state, generate, stop };
}
