import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiDelete } from "../lib/api";

// Types
interface QuestionSet {
  id: string;
  name: string;
  theme: string;
  createdAt: string;
  updatedAt: string;
  _count?: { tossups: number; bonuses: number };
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
