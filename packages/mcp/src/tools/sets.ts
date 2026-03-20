import { createLogger } from "@3roads/shared";
import { z } from "zod";
import { apiGet } from "../lib/api-client.js";

const log = createLogger("mcp:tools");

export const setTools = {
  list_sets: {
    description: "List all question sets",
    parameters: {
      shape: {},
    },
    execute: async () => {
      log.info("list_sets called");
      try {
        const result = await apiGet("/sets");
        log.info("list_sets succeeded", { count: Array.isArray(result) ? (result as unknown[]).length : "n/a" });
        return result;
      } catch (error) {
        log.error("list_sets failed", error);
        throw error;
      }
    },
  },
  get_set: {
    description: "Get details of a specific question set",
    parameters: {
      shape: {
        setId: z.string().describe("The question set ID"),
      },
    },
    execute: async (params: { setId: string }) => {
      log.info("get_set called", { setId: params.setId });
      try {
        const result = await apiGet(`/sets/${params.setId}`);
        log.info(`get_set succeeded for set=${params.setId}`);
        return result;
      } catch (error) {
        log.error(`get_set failed for set=${params.setId}`, error);
        throw error;
      }
    },
  },
};
