import { createLogger, getDb } from "@3roads/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { streamCliChat } from "../services/cli-chat.js";
import { startStream, subscribe } from "../services/stream-manager.js";

const log = createLogger("api:generate");

export const generateRoutes = new Hono();

function pipeStreamToSSE(c: Context, setId: string) {
	log.info(`pipeStreamToSSE — setting up SSE pipe for set ${setId}`);
	return streamSSE(c, async (sseStream) => {
		const handle = subscribe(setId, async (event, data) => {
			try {
				await sseStream.writeSSE({ data, event });
			} catch (err) {
				log.warn(`pipeStreamToSSE — client disconnected during write for set ${setId}`, err);
			}
		});

		if (!handle) {
			log.warn(`pipeStreamToSSE — no active stream for set ${setId}, sending [DONE]`);
			await sseStream.writeSSE({ data: "[DONE]", event: "done" });
			return;
		}

		try {
			await handle.delivered;
			log.info(`pipeStreamToSSE — stream delivered for set ${setId}`);
		} catch (err) {
			log.error(`pipeStreamToSSE — error during stream delivery for set ${setId}`, err);
		} finally {
			handle.unsubscribe();
		}
	});
}

generateRoutes.post("/stream", async (c) => {
	log.info("POST /generate/stream — request received");

	try {
		const body = await c.req.json<{
			theme: string;
			tossupCount: number;
			bonusCount: number;
		}>();

		log.info(`POST /generate/stream — params: theme="${body.theme}" tossupCount=${body.tossupCount} bonusCount=${body.bonusCount}`);

		if (!body.theme || !body.tossupCount || !body.bonusCount) {
			log.warn("POST /generate/stream — missing required fields (theme, tossupCount, bonusCount)");
			return c.json({ error: "theme, tossupCount, and bonusCount are required" }, 400);
		}

		const db = getDb();

		// Create the question set
		const set = await db.questionSet.create({
			data: { name: body.theme, theme: body.theme },
		});

		log.info(`POST /generate/stream — created set ${set.id} theme="${body.theme}" tossups=${body.tossupCount} bonuses=${body.bonusCount}`);

		// Check for existing active stream
		const existingStream = (await import("../services/stream-manager.js")).getStream(set.id);
		if (existingStream && existingStream.status === "streaming") {
			log.info(`POST /generate/stream — reconnecting to active stream for set ${set.id}`);
			return pipeStreamToSSE(c, set.id);
		}

		const systemPrompt = `You are an expert quiz bowl question writer. You write high-quality academic competition questions in standard quiz bowl format.

Set ID for saving questions: ${set.id}

Generate ${body.tossupCount} tossups and ${body.bonusCount} bonuses about: ${body.theme}

For each tossup:
- Write a pyramidal question starting with the hardest clues and progressing to the easiest
- Include a power mark (*) at the transition from hard to moderate difficulty
- Call mcp__3roads__save_tossup with the setId "${set.id}" immediately after writing each tossup

For each bonus:
- Write a leadin that introduces the topic
- Write exactly 3 parts of increasing difficulty (easy/medium/hard)
- Each part is worth 10 points
- Call mcp__3roads__save_bonus with the setId "${set.id}" immediately after writing each bonus`;

		const prompt = `Generate ${body.tossupCount} tossups and ${body.bonusCount} bonuses about: ${body.theme}. Set ID: ${set.id}`;

		log.info(`POST /generate/stream — setting up CLI stream for set ${set.id}`);

		const cliStream = streamCliChat({
			prompt,
			systemPrompt,
		});

		startStream(set.id, cliStream);

		log.info(`POST /generate/stream — CLI stream started, beginning SSE response for set ${set.id}`);

		// Emit the setId as the first SSE event so the frontend knows which set was created
		return streamSSE(c, async (sseStream) => {
			try {
				await sseStream.writeSSE({
					event: "set_created",
					data: JSON.stringify({ setId: set.id, name: set.name, theme: set.theme }),
				});

				const handle = subscribe(set.id, async (event, data) => {
					try {
						await sseStream.writeSSE({ data, event });
					} catch (err) {
						log.warn(`POST /generate/stream — client disconnected during SSE write for set ${set.id}`, err);
					}
				});

				if (!handle) {
					log.warn(`POST /generate/stream — no active stream handle for set ${set.id}, sending [DONE]`);
					await sseStream.writeSSE({ data: "[DONE]", event: "done" });
					return;
				}

				try {
					await handle.delivered;
					log.info(`POST /generate/stream — SSE stream delivered for set ${set.id}`);
				} catch (err) {
					log.error(`POST /generate/stream — error during SSE delivery for set ${set.id}`, err);
				} finally {
					handle.unsubscribe();
				}
			} catch (err) {
				log.error(`POST /generate/stream — error inside SSE handler for set ${set.id}`, err);
			}
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`POST /generate/stream — unhandled error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});
