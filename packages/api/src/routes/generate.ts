import { createLogger, getDb } from "@3roads/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { streamCliChat } from "../services/cli-chat.js";
import { startStream, subscribe } from "../services/stream-manager.js";

const log = createLogger("api");

export const generateRoutes = new Hono();

function pipeStreamToSSE(c: Context, setId: string) {
	return streamSSE(c, async (sseStream) => {
		const handle = subscribe(setId, async (event, data) => {
			try {
				await sseStream.writeSSE({ data, event });
			} catch {
				// Client disconnected during write
			}
		});

		if (!handle) {
			await sseStream.writeSSE({ data: "[DONE]", event: "done" });
			return;
		}

		try {
			await handle.delivered;
		} finally {
			handle.unsubscribe();
		}
	});
}

generateRoutes.post("/stream", async (c) => {
	const body = await c.req.json<{
		theme: string;
		tossupCount: number;
		bonusCount: number;
	}>();

	if (!body.theme || !body.tossupCount || !body.bonusCount) {
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

	const cliStream = streamCliChat({
		prompt,
		systemPrompt,
	});

	startStream(set.id, cliStream);

	// Emit the setId as the first SSE event so the frontend knows which set was created
	return streamSSE(c, async (sseStream) => {
		await sseStream.writeSSE({
			event: "set_created",
			data: JSON.stringify({ setId: set.id, name: set.name, theme: set.theme }),
		});

		const handle = subscribe(set.id, async (event, data) => {
			try {
				await sseStream.writeSSE({ data, event });
			} catch {
				// Client disconnected during write
			}
		});

		if (!handle) {
			await sseStream.writeSSE({ data: "[DONE]", event: "done" });
			return;
		}

		try {
			await handle.delivered;
		} finally {
			handle.unsubscribe();
		}
	});
});
