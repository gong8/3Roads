import { createLogger } from "@3roads/shared";
import { z } from "zod";
import { apiGet } from "../lib/api-client.js";

const log = createLogger("mcp:tools");

export const searchTools = {
  search_questions: {
    description: "Search for quiz bowl questions by text, category, or type",
    parameters: {
      shape: {
        query: z.string().describe("Search query text"),
        category: z.string().optional().describe("Filter by category"),
        type: z.enum(["tossup", "bonus"]).optional().describe("Filter by question type"),
        limit: z.number().optional().default(20).describe("Maximum number of results (default 20)"),
      },
    },
    execute: async (params: {
      query: string;
      category?: string;
      type?: "tossup" | "bonus";
      limit?: number;
    }) => {
      log.info("search_questions called", { query: params.query, category: params.category, type: params.type, limit: params.limit });
      try {
        const searchParams = new URLSearchParams();
        searchParams.set("query", params.query);
        if (params.category) searchParams.set("category", params.category);
        if (params.type) searchParams.set("type", params.type);
        if (params.limit) searchParams.set("limit", String(params.limit));
        const result = await apiGet(`/questions/search?${searchParams.toString()}`);
        log.info("search_questions succeeded", { count: Array.isArray(result) ? (result as unknown[]).length : "n/a" });
        return result;
      } catch (error) {
        log.error(`search_questions failed for query="${params.query}"`, error);
        throw error;
      }
    },
  },
};
