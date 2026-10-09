import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../lib/api";

type Status = "idle" | "generating" | "complete" | "error";

interface SetResponse {
  id: string;
  status: Status;
  cost: number | null;
  tossups: unknown[];
  bonuses: unknown[];
}

interface GenerateState {
  isGenerating: boolean;
  setId: string | null;
  status: Status;
  tossupCount: number;
  bonusCount: number;
  targetTossups: number;
  targetBonuses: number;
  cost: number | null;
  error: string | null;
}

export function useGenerate() {
  const [state, setState] = useState<GenerateState>({
    isGenerating: false,
    setId: null,
    status: "idle",
    tossupCount: 0,
    bonusCount: 0,
    targetTossups: 0,
    targetBonuses: 0,
    cost: null,
    error: null,
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qc = useQueryClient();

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => stopPolling, [stopPolling]);

  const generate = useCallback(async (
    theme: string,
    tossupCount: number,
    bonusCount: number,
    difficulty: string,
    model: string,
    pictureCount = 0,
  ) => {
    stopPolling();

    setState({
      isGenerating: true,
      setId: null,
      status: "generating",
      tossupCount: 0,
      bonusCount: 0,
      targetTossups: tossupCount,
      targetBonuses: bonusCount,
      cost: null,
      error: null,
    });

    try {
      const res = await apiPost<{ setId: string }>("/generate", {
        theme,
        tossupCount,
        bonusCount,
        pictureCount,
        difficulty,
        model,
      });

      setState((s) => ({ ...s, setId: res.setId }));

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const set = await apiGet<SetResponse>(`/sets/${res.setId}`);
          const tc = set.tossups?.length ?? 0;
          const bc = set.bonuses?.length ?? 0;
          const status = set.status as Status;

          setState((s) => ({
            ...s,
            tossupCount: tc,
            bonusCount: bc,
            status,
          }));

          if (status === "complete" || status === "error") {
            stopPolling();
            setState((s) => ({
              ...s,
              isGenerating: false,
              cost: set.cost,
              error: status === "error" ? "Generation failed" : null,
            }));
            qc.invalidateQueries({ queryKey: ["sets"] });
          }
        } catch (err) {
          // 404: the server deletes sets that finish with no questions (see
          // generate-orchestrator), often before we observe status "error".
          // Other errors are transient — keep trying.
          if ((err as Error).message === "API error 404") {
            stopPolling();
            setState((s) => ({
              ...s,
              isGenerating: false,
              status: "error",
              error: "Generation failed — no questions were produced (check API logs)",
            }));
          }
        }
      }, 2000);
    } catch (err) {
      setState((s) => ({
        ...s,
        isGenerating: false,
        error: (err as Error).message,
      }));
    }
  }, [stopPolling, qc]);

  return { ...state, generate };
}
