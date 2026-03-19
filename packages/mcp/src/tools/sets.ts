import { z } from "zod";
import { apiGet } from "../lib/api-client.js";

export const setTools = {
  list_sets: {
    description: "List all question sets",
    parameters: {
      shape: {},
    },
    execute: async () => {
      return apiGet("/sets");
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
      return apiGet(`/sets/${params.setId}`);
    },
  },
};
