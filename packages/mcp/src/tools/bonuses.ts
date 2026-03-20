import { createLogger } from "@3roads/shared";
import { z } from "zod";
import { apiPost } from "../lib/api-client.js";

const log = createLogger("mcp:tools");

export const bonusTools = {
  save_bonus: {
    description: "Save a quiz bowl bonus question to a set",
    parameters: {
      shape: {
        setId: z.string().describe("The question set ID"),
        leadin: z.string().describe("The bonus leadin text"),
        part1Text: z.string().describe("Part 1 question text"),
        part1Answer: z.string().describe("Part 1 answer"),
        part2Text: z.string().describe("Part 2 question text"),
        part2Answer: z.string().describe("Part 2 answer"),
        part3Text: z.string().describe("Part 3 question text"),
        part3Answer: z.string().describe("Part 3 answer"),
        category: z.string().describe("Question category (e.g., Science, History)"),
        subcategory: z.string().describe("Question subcategory"),
        difficulty: z.string().describe("Difficulty level"),
      },
    },
    execute: async (params: {
      setId: string;
      leadin: string;
      part1Text: string;
      part1Answer: string;
      part2Text: string;
      part2Answer: string;
      part3Text: string;
      part3Answer: string;
      category: string;
      subcategory: string;
      difficulty: string;
    }) => {
      log.info("save_bonus called", { setId: params.setId, category: params.category });
      try {
        const result = await apiPost(`/sets/${params.setId}/bonuses`, params);
        log.info(`save_bonus succeeded for set=${params.setId} category=${params.category}`);
        return result;
      } catch (error) {
        log.error(`save_bonus failed for set=${params.setId}`, error);
        throw error;
      }
    },
  },
};
