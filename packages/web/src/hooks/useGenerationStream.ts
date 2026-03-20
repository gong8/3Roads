import { useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { streamSSE } from "../lib/sse";

interface StreamEvent {
  type: string;
  data: unknown;
}

interface GenerationState {
  isStreaming: boolean;
  content: string;
  events: StreamEvent[];
  setId: string | null;
  error: string | null;
  savedTossups: number;
  savedBonuses: number;
  targetTossups: number;
  targetBonuses: number;
}

export function useGenerationStream() {
  const [state, setState] = useState<GenerationState>({
    isStreaming: false,
    content: "",
    events: [],
    setId: null,
    error: null,
    savedTossups: 0,
    savedBonuses: 0,
    targetTossups: 0,
    targetBonuses: 0,
  });
  const abortRef = useRef<AbortController | null>(null);
  const qc = useQueryClient();

  const generate = useCallback(async (theme: string, tossupCount: number, bonusCount: number) => {
    console.log("[3roads:gen]", "generate() called:", { theme, tossupCount, bonusCount });

    if (abortRef.current) {
      console.log("[3roads:gen]", "aborting previous generation");
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    console.log("[3roads:gen]", "state -> streaming started");
    setState({
      isStreaming: true,
      content: "",
      events: [],
      setId: null,
      error: null,
      savedTossups: 0,
      savedBonuses: 0,
      targetTossups: tossupCount,
      targetBonuses: bonusCount,
    });

    try {
      for await (const { event, data } of streamSSE("/api/generate/stream", { theme, tossupCount, bonusCount }, controller.signal)) {
        if (event === "done") {
          console.log("[3roads:gen]", "received done event, breaking");
          break;
        }

        if (event === "error") {
          console.error("[3roads:gen]", "received error event:", data);
          setState((s) => ({ ...s, error: data, isStreaming: false }));
          break;
        }

        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { parsed = data; }

        console.log("[3roads:gen]", "parsed event:", event, typeof parsed === "object" ? JSON.stringify(parsed).slice(0, 150) : parsed);

        setState((s) => {
          const newState = { ...s, events: [...s.events, { type: event, data: parsed }] };

          if (event === "content" && typeof parsed === "object" && parsed !== null && "content" in parsed) {
            newState.content = s.content + (parsed as { content: string }).content;
          }

          if (event === "set_created" && typeof parsed === "object" && parsed !== null && "setId" in parsed) {
            newState.setId = (parsed as { setId: string }).setId;
            console.log("[3roads:gen]", "set created:", (parsed as { setId: string }).setId);
          }

          // Track saved questions by counting tool_result events for save_ tools
          if (event === "tool_result" && typeof parsed === "object" && parsed !== null) {
            const toolCallId = (parsed as { toolCallId?: string }).toolCallId ?? "";
            // Find the matching tool_call_start to know which tool completed
            const matchingStart = s.events.find(
              (e) => e.type === "tool_call_args" && typeof e.data === "object" && e.data !== null && (e.data as { toolCallId?: string }).toolCallId === toolCallId,
            );
            if (matchingStart) {
              const toolName = (matchingStart.data as { toolName?: string }).toolName ?? "";
              const isError = (parsed as { isError?: boolean }).isError;
              if (!isError) {
                if (toolName.includes("save_tossup")) {
                  newState.savedTossups = s.savedTossups + 1;
                  console.log("[3roads:gen]", `tossup saved (${newState.savedTossups}/${s.targetTossups})`);
                } else if (toolName.includes("save_bonus")) {
                  newState.savedBonuses = s.savedBonuses + 1;
                  console.log("[3roads:gen]", `bonus saved (${newState.savedBonuses}/${s.targetBonuses})`);
                }
              }
            }
          }

          return newState;
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("[3roads:gen]", "generation error:", (err as Error).message, err);
        setState((s) => ({ ...s, error: (err as Error).message }));
      } else {
        console.log("[3roads:gen]", "generation aborted by user");
      }
    } finally {
      console.log("[3roads:gen]", "state -> streaming ended, invalidating sets query");
      setState((s) => ({ ...s, isStreaming: false }));
      qc.invalidateQueries({ queryKey: ["sets"] });
      abortRef.current = null;
    }
  }, [qc]);

  const stop = useCallback(() => {
    console.log("[3roads:gen]", "stop() called");
    abortRef.current?.abort();
  }, []);

  return { ...state, generate, stop };
}
