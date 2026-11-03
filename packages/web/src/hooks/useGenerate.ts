import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../lib/api";

type Status = "generating" | "complete" | "error";

/** One set being written (or finished) from the generate page. */
export interface GenerateRun {
  setId: string;
  name: string;
  status: Status;
  tossupCount: number;
  bonusCount: number;
  targetTossups: number;
  targetBonuses: number;
  cost: number | null;
  error: string | null;
}

export interface GenerateRequest {
  theme: string;
  tossupCount: number;
  bonusCount: number;
  difficulty: string;
  model: string;
  pictureCount: number;
  style: string;
  /** Separate sets on the same settings; the server keeps their answers apart */
  packetCount: number;
}

interface SetSummary {
  id: string;
  status: string;
  cost: number | null;
  tossupCount?: number;
  bonusCount?: number;
}

// Runs live outside the page, so they keep their place when you navigate away and come back
let runs: GenerateRun[] = [];
const listeners = new Set<() => void>();

function setRuns(next: GenerateRun[]) {
  runs = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Update each in-progress run from the set list: one request however many are running. */
async function refreshRuns(): Promise<boolean> {
  const sets = await apiGet<SetSummary[]>("/sets");
  const byId = new Map(sets.map((s) => [s.id, s]));
  let finished = false;
  setRuns(runs.map((run) => {
    if (run.status !== "generating") return run;
    const set = byId.get(run.setId);
    if (!set) {
      // The server deletes sets that finish with no questions (see generate-orchestrator)
      finished = true;
      return { ...run, status: "error", error: "no questions were produced (check API logs)" };
    }
    const status = set.status === "complete" || set.status === "error" ? set.status : "generating";
    if (status !== "generating") finished = true;
    return {
      ...run,
      status,
      tossupCount: set.tossupCount ?? 0,
      bonusCount: set.bonusCount ?? 0,
      cost: set.cost,
      error: status === "error" ? "generation failed" : null,
    };
  }));
  return finished;
}

export function useGenerate() {
  const current = useSyncExternalStore(subscribe, () => runs);
  const qc = useQueryClient();
  const anyGenerating = current.some((r) => r.status === "generating");

  useEffect(() => {
    if (!anyGenerating) return;
    const id = setInterval(async () => {
      try {
        if (await refreshRuns()) qc.invalidateQueries({ queryKey: ["sets"] });
      } catch {
        // Transient — keep trying
      }
    }, 2000);
    return () => clearInterval(id);
  }, [anyGenerating, qc]);

  /** Start a request; its packets join the list. Throws if the server refuses it. */
  const start = useCallback(async (req: GenerateRequest) => {
    const res = await apiPost<{ sets: { id: string; name: string }[] }>("/generate", {
      theme: req.theme,
      tossupCount: req.tossupCount,
      bonusCount: req.bonusCount,
      pictureCount: req.pictureCount,
      difficulty: req.difficulty,
      style: req.style || undefined,
      packetCount: req.packetCount,
      model: req.model,
    });
    const added: GenerateRun[] = res.sets.map((s) => ({
      setId: s.id,
      name: s.name,
      status: "generating",
      tossupCount: 0,
      bonusCount: 0,
      targetTossups: req.tossupCount,
      targetBonuses: req.bonusCount,
      cost: null,
      error: null,
    }));
    setRuns([...added, ...runs]);
  }, []);

  const dismiss = useCallback((setId: string) => {
    setRuns(runs.filter((r) => r.setId !== setId));
  }, []);

  return { runs: current, start, dismiss };
}
