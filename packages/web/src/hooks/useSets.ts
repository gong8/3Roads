import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiDelete, apiPatch } from "../lib/api";

// Types
interface QuestionSet {
  id: string;
  name: string;
  theme: string;
  difficulty: string;
  status: "idle" | "generating" | "complete" | "error";
  cost: number | null;
  createdAt: string;
  updatedAt: string;
  folderId: string | null;
  /** True when the signed-in user owns this set. */
  mine: boolean;
  isPrivate: boolean;
  tossupCount?: number;
  bonusCount?: number;
  tossups?: Tossup[];
  bonuses?: Bonus[];
}

interface Tossup {
  id: string;
  question: string;
  answer: string;
  powerMarkIndex: number | null;
  category: string;
  subcategory: string;
  difficulty: string;
}

interface BonusPart {
  id: string;
  partNum: number;
  text: string;
  answer: string;
  value: number;
}

interface Bonus {
  id: string;
  leadin: string;
  category: string;
  subcategory: string;
  difficulty: string;
  parts: BonusPart[];
}

export type { QuestionSet, Tossup, Bonus, BonusPart };

export function useSets() {
  return useQuery({
    queryKey: ["sets"],
    queryFn: () => apiGet<QuestionSet[]>("/sets"),
    // Keep counts fresh while any set is still being generated
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "generating") ? 3000 : false,
  });
}

export function useSet(id: string) {
  return useQuery({
    queryKey: ["sets", id],
    queryFn: () => apiGet<QuestionSet>(`/sets/${id}`),
    enabled: !!id,
  });
}

export function useDeleteSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/sets/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sets"] }),
  });
}

export function useUpdateSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; folderId?: string | null; isPrivate?: boolean }) =>
      apiPatch<QuestionSet>(`/sets/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sets"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}
