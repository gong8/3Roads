import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPatch, apiPost } from "../lib/api";

export interface LearnPack {
  id: string;
  name: string;
  topic: string;
  promptKind: string;
  answerKind: string;
  status: "generating" | "complete" | "error";
  error: string | null;
  cost: number | null;
  isPrivate: boolean;
  createdAt: string;
  mine: boolean;
  cardCount?: number;
  cards?: LearnCard[];
}

export interface LearnCard {
  id: string;
  prompt: string;
  answer: string;
  detail: string | null;
}

export type Verdict = "correct" | "incorrect" | "prompt";

export function useLearnPacks() {
  return useQuery({
    queryKey: ["learn"],
    queryFn: () => apiGet<LearnPack[]>("/learn"),
    // Keep card counts moving while a pack is being written
    refetchInterval: (query) => (query.state.data?.some((p) => p.status === "generating") ? 3000 : false),
  });
}

export function useLearnPack(id: string) {
  return useQuery({
    queryKey: ["learn", id],
    queryFn: () => apiGet<LearnPack>(`/learn/${id}`),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.status === "generating" ? 3000 : false),
  });
}

export function useCreateLearnPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      topic: string;
      promptKind: string;
      answerKind: string;
      answerCount: number;
      cardsPerAnswer: number;
      model: string;
    }) => apiPost<LearnPack>("/learn", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learn"] }),
  });
}

export function useUpdateLearnPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; isPrivate?: boolean; name?: string }) => apiPatch(`/learn/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learn"] }),
  });
}

export function useDeleteLearnPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/learn/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["learn"] }),
  });
}

export function judgeCard(cardId: string, answer: string): Promise<{ verdict: Verdict }> {
  return apiPost(`/learn/cards/${cardId}/judge`, { answer });
}
