import { createLogger } from "@3roads/shared";
import { z } from "zod";
import { apiPost } from "../lib/api-client.js";

const log = createLogger("mcp:tools");

const tossupShape = {
  question: z.string().describe("The tossup question text"),
  answer: z.string().describe("The answer to the tossup"),
  powerMarkIndex: z.number().optional().describe("Character index of the power mark (*)"),
  category: z.string().describe("Question category (e.g., Science, History)"),
  subcategory: z.string().describe("Question subcategory"),
  difficulty: z.string().describe("Difficulty level"),
};

export const tossupTools = {
  save_tossup: {
    description: "Save a quiz bowl tossup question to a set",
    parameters: {
      shape: {
        setId: z.string().describe("The question set ID"),
        ...tossupShape,
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
      log.info("save_tossup called", { setId: params.setId, category: params.category, answer: params.answer });
      try {
        const result = await apiPost(`/sets/${params.setId}/tossups`, params);
        log.info(`save_tossup succeeded for set=${params.setId} category=${params.category}`);
        return result;
      } catch (error) {
        log.error(`save_tossup failed for set=${params.setId}`, error);
        throw error;
      }
    },
  },

  save_tossups_batch: {
    description: "Save multiple quiz bowl tossup questions to a set in one call. Use this instead of calling save_tossup multiple times.",
    parameters: {
      shape: {
        setId: z.string().describe("The question set ID"),
        tossups: z.array(z.object(tossupShape)).describe("Array of tossup objects to save"),
      },
    },
    execute: async (params: {
      setId: string;
      tossups: Array<{
        question: string;
        answer: string;
        powerMarkIndex?: number;
        category: string;
        subcategory: string;
        difficulty: string;
      }>;
    }) => {
      log.info("save_tossups_batch called", { setId: params.setId, count: params.tossups.length });
      try {
        const result = await apiPost(`/sets/${params.setId}/tossups/batch`, { tossups: params.tossups });
        log.info(`save_tossups_batch succeeded for set=${params.setId} count=${params.tossups.length}`);
        return result;
      } catch (error) {
        log.error(`save_tossups_batch failed for set=${params.setId}`, error);
        throw error;
      }
    },
  },
};
