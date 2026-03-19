import { z } from "zod";
import { apiPost } from "../lib/api-client.js";

export const tossupTools = {
  save_tossup: {
    description: "Save a quiz bowl tossup question to a set",
    parameters: {
      shape: {
        setId: z.string().describe("The question set ID"),
        question: z.string().describe("The tossup question text"),
        answer: z.string().describe("The answer to the tossup"),
        powerMarkIndex: z.number().optional().describe("Character index of the power mark (*)"),
        category: z.string().describe("Question category (e.g., Science, History)"),
        subcategory: z.string().describe("Question subcategory"),
        difficulty: z.string().describe("Difficulty level"),
      },
    },
    execute: async (params: {
      setId: string;
      question: string;
      answer: string;
      powerMarkIndex?: number;
      category: string;
      subcategory: string;
      difficulty: string;
    }) => {
      return apiPost(`/sets/${params.setId}/tossups`, params);
    },
  },
};
