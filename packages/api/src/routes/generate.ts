import { createLogger, getDb } from "@3roads/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { streamCliChat } from "../services/cli-chat.js";
import { runGeneration } from "../services/generate-orchestrator.js";
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
			difficulty: string;
			model?: string;
		}>();

		log.info(`POST /generate/stream — params: theme="${body.theme}" tossupCount=${body.tossupCount} bonusCount=${body.bonusCount} difficulty="${body.difficulty}"`);

		if (!body.theme || (body.tossupCount === undefined && body.bonusCount === undefined)) {
			log.warn("POST /generate/stream — missing required fields");
			return c.json({ error: "theme and at least one of tossupCount/bonusCount are required" }, 400);
		}

		const difficulty = body.difficulty || "Regular";

		const db = getDb();

		// Create the question set
		const set = await db.questionSet.create({
			data: { name: body.theme, theme: body.theme, difficulty },
		});

		log.info(`POST /generate/stream — created set ${set.id} theme="${body.theme}" tossups=${body.tossupCount} bonuses=${body.bonusCount}`);

		// Check for existing active stream
		const existingStream = (await import("../services/stream-manager.js")).getStream(set.id);
		if (existingStream && existingStream.status === "streaming") {
			log.info(`POST /generate/stream — reconnecting to active stream for set ${set.id}`);
			return pipeStreamToSSE(c, set.id);
		}

		const systemPrompt = `You are an expert quiz bowl question writer producing competition-quality academic questions. Your output must match the quality of questions from NAQT, ACF, or PACE tournaments.

Set ID: ${set.id}
Target difficulty: ${difficulty}
Theme: ${body.theme}
Generate: ${body.tossupCount} tossup(s) and ${body.bonusCount} bonus(es)

## DIFFICULTY CALIBRATION
Calibrate clue difficulty and answer selection to the "${difficulty}" level:
- Middle School: common curriculum topics, straightforward clues, well-known answers
- Easy High School: introductory-level academic content, accessible to newer players
- Regular High School: standard varsity tournament level (e.g., NAQT IS-A)
- Hard High School: championship-level high school (e.g., PACE NSC, HSNCT)
- Easy College: novice collegiate level (e.g., ACF Fall)
- Regular College: standard collegiate level (e.g., ACF Regionals)
- Hard College: difficult collegiate level (e.g., ACF Nationals)
- Open: expert-level open tournaments (e.g., Chicago Open, EFT)

## CRITICAL RULES
1. **EVERY question in this set MUST have a UNIQUE answer.** No two tossups, no two bonuses, and no tossup and bonus may share the same answer. Plan all your answers before writing any questions.
2. **Never give away the answer.** No clue should make the answer trivially obvious. Avoid:
   - Etymology that transparently maps to the answer (e.g., "this word comes from the French 'hasard'" when the answer IS "hazard")
   - Restating the answer in slightly different words
   - Clues so obvious they could only describe the answer (e.g., "this element has atomic number 79" as an early clue for gold)
3. **Every clue must be a substantive, independently verifiable fact.** No filler, no vague statements, no padding.

## TOSSUP FORMAT (Pyramidal Structure)
Each tossup MUST follow strict pyramidal structure:
- **First 1-3 sentences:** Obscure, specific facts that only deep experts would know. These are the "power-worthy" clues.
- **Middle sentences:** Moderately difficult facts that knowledgeable players would recognize.
- **Power mark (*) placement:** Insert after the transition from hard to moderate clues, roughly 1/3 to 1/2 through the question.
- **Final sentence (giveaway):** A well-known identifying fact, preceded by "For 10 points," or "FTP," — this should be answerable by most players at the target difficulty level, but should NOT be so obvious that it insults the player.
- **End with:** "ANSWER: [answer]" (include acceptable alternate answers in brackets if applicable)

The giveaway clue must still require SOME knowledge — it should uniquely identify the answer but not be a direct restatement. Good giveaway: "For 10 points, name this author of *The Great Gatsby*." Bad giveaway: "For 10 points, name this novel by F. Scott Fitzgerald about Jay Gatsby."

## BONUS FORMAT
Each bonus has:
- **Leadin:** A thematic introduction connecting the three parts (1-2 sentences)
- **Part 1 [10]:** Easiest — most players at this difficulty should get it
- **Part 2 [10]:** Medium — requires solid knowledge
- **Part 3 [10]:** Hardest — challenges even strong players
- Each part must have a DIFFERENT answer from the other parts and from all other questions in the set

## WORKFLOW
1. First, plan all ${body.tossupCount + body.bonusCount} answers to ensure they are all unique.
2. Write ALL ${body.tossupCount} tossups, then call mcp__3roads__save_tossups_batch ONCE with setId "${set.id}" and the full array of tossups.
3. Write ALL ${body.bonusCount} bonuses, then call mcp__3roads__save_bonuses_batch ONCE with setId "${set.id}" and the full array of bonuses.
4. For difficulty field in each question, use "${difficulty}".
5. Do NOT call individual save_tossup or save_bonus tools — always use the batch versions.`;

		const prompt = `Generate ${body.tossupCount} tossup(s) and ${body.bonusCount} bonus(es) about "${body.theme}" at ${difficulty} difficulty. Set ID: ${set.id}. Remember: all answers must be unique, use strict pyramid structure, and never give away the answer in clues.`;

		log.info(`POST /generate/stream — setting up CLI stream for set ${set.id}`);

		const cliStream = streamCliChat({
			prompt,
			systemPrompt,
			model: body.model || "haiku",
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
					// Clean up if the set ended up with no questions
					const db = getDb();
					const counts = await db.questionSet.findUnique({
						where: { id: set.id },
						include: { _count: { select: { tossups: true, bonuses: true } } },
					}).catch(() => null);
					if (counts && counts._count.tossups === 0 && counts._count.bonuses === 0) {
						log.warn(`POST /generate/stream — no questions generated for set ${set.id}, deleting`);
						await db.questionSet.delete({ where: { id: set.id } }).catch(() => {});
					}
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

// Non-streaming generation with parallel CLI processes + DB polling
generateRoutes.post("/", async (c) => {
	log.info("POST /generate — request received");

	try {
		const body = await c.req.json<{
			theme: string;
			tossupCount: number;
			bonusCount: number;
			pictureCount?: number;
			difficulty: string;
			model?: string;
		}>();

		if (!body.theme || (body.tossupCount === undefined && body.bonusCount === undefined)) {
			return c.json({ error: "theme and at least one of tossupCount/bonusCount are required" }, 400);
		}

		const difficulty = body.difficulty || "Regular High School";
		const db = getDb();

		const set = await db.questionSet.create({
			data: {
				name: body.theme,
				theme: body.theme,
				difficulty,
				status: "generating",
			},
		});

		log.info(`POST /generate — created set ${set.id}, launching background generation`);

		// Fire-and-forget — generation updates status in DB
		runGeneration({
			setId: set.id,
			theme: body.theme,
			difficulty,
			tossupCount: body.tossupCount || 0,
			bonusCount: body.bonusCount || 0,
			pictureCount: body.pictureCount || 0,
			model: body.model || "haiku",
		}).catch((err) => {
			log.error(`POST /generate — background generation failed for ${set.id}: ${err}`);
		});

		return c.json({
			setId: set.id,
			status: "generating",
			tossupCount: body.tossupCount || 0,
			bonusCount: body.bonusCount || 0,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`POST /generate — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});
