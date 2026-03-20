import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";

const log = createLogger("api:routes");

export const setsRoutes = new Hono();

// List all sets with question counts
setsRoutes.get("/", async (c) => {
	log.info("GET /sets — request received");
	try {
		const db = getDb();
		const sets = await db.questionSet.findMany({
			orderBy: { createdAt: "desc" },
			include: {
				_count: {
					select: { tossups: true, bonuses: true },
				},
			},
		});

		const result = sets.map(({ _count, ...rest }) => ({
			...rest,
			tossupCount: _count.tossups,
			bonusCount: _count.bonuses,
		}));

		log.info(`GET /sets — returning ${result.length} sets`);
		return c.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`GET /sets — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Get set with all tossups and bonuses (bonuses include parts)
setsRoutes.get("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`GET /sets/${id} — request received`);
	try {
		const db = getDb();

		const set = await db.questionSet.findUnique({
			where: { id },
			include: {
				tossups: { orderBy: { createdAt: "asc" } },
				bonuses: {
					orderBy: { createdAt: "asc" },
					include: {
						parts: { orderBy: { partNum: "asc" } },
					},
				},
			},
		});

		if (!set) {
			log.warn(`GET /sets/${id} — set not found`);
			return c.json({ error: "Set not found" }, 404);
		}

		log.info(`GET /sets/${id} — ${set.tossups.length} tossups, ${set.bonuses.length} bonuses`);
		return c.json(set);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`GET /sets/${id} — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Create empty set
setsRoutes.post("/", async (c) => {
	log.info("POST /sets — request received");
	try {
		const { name, theme } = await c.req.json<{ name: string; theme: string }>();
		log.info(`POST /sets — params: name="${name}" theme="${theme}"`);
		const db = getDb();

		if (!name || !theme) {
			log.warn("POST /sets — missing required fields (name, theme)");
			return c.json({ error: "name and theme are required" }, 400);
		}

		const set = await db.questionSet.create({
			data: { name, theme },
		});

		log.info(`POST /sets — created ${set.id} "${set.name}"`);
		return c.json(set, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`POST /sets — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Update name/theme/folderId
setsRoutes.patch("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`PATCH /sets/${id} — request received`);
	try {
		const body = await c.req.json<{ name?: string; theme?: string; folderId?: string | null }>();
		log.info(`PATCH /sets/${id} — params: name="${body.name}" theme="${body.theme}" folderId="${body.folderId}"`);
		const db = getDb();

		const data: Record<string, unknown> = {};
		if (body.name) data.name = body.name;
		if (body.theme) data.theme = body.theme;
		if ("folderId" in body) data.folderId = body.folderId ?? null;

		if (Object.keys(data).length === 0) {
			log.warn(`PATCH /sets/${id} — nothing to update`);
			return c.json({ error: "Nothing to update" }, 400);
		}

		const set = await db.questionSet.update({
			where: { id },
			data,
		});

		log.info(`PATCH /sets/${id} — updated`);
		return c.json(set);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("P2025")) {
			return c.json({ error: "Set not found" }, 404);
		}
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`PATCH /sets/${id} — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Delete set (cascade)
setsRoutes.delete("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`DELETE /sets/${id} — request received`);
	try {
		const db = getDb();

		await db.questionSet.delete({ where: { id } });

		log.info(`DELETE /sets/${id} — deleted`);
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`DELETE /sets/${id} — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Save tossup to a set
setsRoutes.post("/:setId/tossups", async (c) => {
	const { setId } = c.req.param();
	log.info(`POST /sets/${setId}/tossups — request received`);
	try {
		const body = await c.req.json<{
			question: string;
			answer: string;
			powerMarkIndex?: number;
			category: string;
			subcategory: string;
			difficulty: string;
		}>();
		log.info(`POST /sets/${setId}/tossups — params: answer="${body.answer}" category="${body.category}"`);
		const db = getDb();

		const set = await db.questionSet.findUnique({ where: { id: setId } });
		if (!set) {
			log.warn(`POST /sets/${setId}/tossups — set not found`);
			return c.json({ error: "Set not found" }, 404);
		}

		if (!body.question || !body.answer || !body.category || !body.subcategory || !body.difficulty) {
			log.warn(`POST /sets/${setId}/tossups — missing required fields`);
			return c.json({ error: "question, answer, category, subcategory, and difficulty are required" }, 400);
		}

		const tossup = await db.tossup.create({
			data: {
				setId,
				question: body.question,
				answer: body.answer,
				powerMarkIndex: body.powerMarkIndex ?? null,
				category: body.category,
				subcategory: body.subcategory,
				difficulty: body.difficulty,
			},
		});

		log.info(`POST /sets/${setId}/tossups — created ${tossup.id}`);
		return c.json(tossup, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`POST /sets/${setId}/tossups — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Batch save tossups to a set
setsRoutes.post("/:setId/tossups/batch", async (c) => {
	const { setId } = c.req.param();
	log.info(`POST /sets/${setId}/tossups/batch — request received`);
	try {
		const { tossups } = await c.req.json<{
			tossups: Array<{
				question: string;
				answer: string;
				powerMarkIndex?: number;
				category: string;
				subcategory: string;
				difficulty: string;
			}>;
		}>();
		const db = getDb();

		const set = await db.questionSet.findUnique({ where: { id: setId } });
		if (!set) {
			log.warn(`POST /sets/${setId}/tossups/batch — set not found`);
			return c.json({ error: "Set not found" }, 404);
		}

		if (!Array.isArray(tossups) || tossups.length === 0) {
			log.warn(`POST /sets/${setId}/tossups/batch — empty or missing tossups array`);
			return c.json({ error: "tossups array is required and must not be empty" }, 400);
		}

		for (const t of tossups) {
			if (!t.question || !t.answer || !t.category || !t.subcategory || !t.difficulty) {
				log.warn(`POST /sets/${setId}/tossups/batch — missing required fields in tossup`);
				return c.json({ error: "Each tossup requires question, answer, category, subcategory, and difficulty" }, 400);
			}
		}

		const results = await db.$transaction(async (tx) => {
			await tx.tossup.createMany({
				data: tossups.map((t) => ({
					setId,
					question: t.question,
					answer: t.answer,
					powerMarkIndex: t.powerMarkIndex ?? null,
					category: t.category,
					subcategory: t.subcategory,
					difficulty: t.difficulty,
				})),
			});
			return tx.tossup.findMany({
				where: { setId },
				orderBy: { createdAt: "asc" },
			});
		});

		log.info(`POST /sets/${setId}/tossups/batch — created ${tossups.length} tossups`);
		return c.json(results, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`POST /sets/${setId}/tossups/batch — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Batch save bonuses to a set
setsRoutes.post("/:setId/bonuses/batch", async (c) => {
	const { setId } = c.req.param();
	log.info(`POST /sets/${setId}/bonuses/batch — request received`);
	try {
		const { bonuses } = await c.req.json<{
			bonuses: Array<{
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
			}>;
		}>();
		const db = getDb();

		const set = await db.questionSet.findUnique({ where: { id: setId } });
		if (!set) {
			log.warn(`POST /sets/${setId}/bonuses/batch — set not found`);
			return c.json({ error: "Set not found" }, 404);
		}

		if (!Array.isArray(bonuses) || bonuses.length === 0) {
			log.warn(`POST /sets/${setId}/bonuses/batch — empty or missing bonuses array`);
			return c.json({ error: "bonuses array is required and must not be empty" }, 400);
		}

		for (const b of bonuses) {
			if (
				!b.leadin ||
				!b.part1Text || !b.part1Answer ||
				!b.part2Text || !b.part2Answer ||
				!b.part3Text || !b.part3Answer ||
				!b.category || !b.subcategory || !b.difficulty
			) {
				log.warn(`POST /sets/${setId}/bonuses/batch — missing required fields in bonus`);
				return c.json({ error: "Each bonus requires leadin, all 3 parts (text + answer), category, subcategory, and difficulty" }, 400);
			}
		}

		const results = await db.$transaction(async (tx) => {
			for (const b of bonuses) {
				const bonus = await tx.bonus.create({
					data: {
						setId,
						leadin: b.leadin,
						category: b.category,
						subcategory: b.subcategory,
						difficulty: b.difficulty,
					},
				});
				await tx.bonusPart.createMany({
					data: [
						{ bonusId: bonus.id, partNum: 1, text: b.part1Text, answer: b.part1Answer, value: 10 },
						{ bonusId: bonus.id, partNum: 2, text: b.part2Text, answer: b.part2Answer, value: 10 },
						{ bonusId: bonus.id, partNum: 3, text: b.part3Text, answer: b.part3Answer, value: 10 },
					],
				});
			}
			return tx.bonus.findMany({
				where: { setId },
				orderBy: { createdAt: "asc" },
				include: { parts: { orderBy: { partNum: "asc" } } },
			});
		});

		log.info(`POST /sets/${setId}/bonuses/batch — created ${bonuses.length} bonuses`);
		return c.json(results, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`POST /sets/${setId}/bonuses/batch — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

// Save bonus + 3 parts to a set (transaction)
setsRoutes.post("/:setId/bonuses", async (c) => {
	const { setId } = c.req.param();
	log.info(`POST /sets/${setId}/bonuses — request received`);
	try {
		const body = await c.req.json<{
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
		}>();
		log.info(`POST /sets/${setId}/bonuses — params: category="${body.category}" difficulty="${body.difficulty}"`);
		const db = getDb();

		const set = await db.questionSet.findUnique({ where: { id: setId } });
		if (!set) {
			log.warn(`POST /sets/${setId}/bonuses — set not found`);
			return c.json({ error: "Set not found" }, 404);
		}

		if (
			!body.leadin ||
			!body.part1Text || !body.part1Answer ||
			!body.part2Text || !body.part2Answer ||
			!body.part3Text || !body.part3Answer ||
			!body.category || !body.subcategory || !body.difficulty
		) {
			log.warn(`POST /sets/${setId}/bonuses — missing required fields`);
			return c.json({ error: "leadin, all 3 parts (text + answer), category, subcategory, and difficulty are required" }, 400);
		}

		const bonus = await db.$transaction(async (tx) => {
			const b = await tx.bonus.create({
				data: {
					setId,
					leadin: body.leadin,
					category: body.category,
					subcategory: body.subcategory,
					difficulty: body.difficulty,
				},
			});

			await tx.bonusPart.createMany({
				data: [
					{ bonusId: b.id, partNum: 1, text: body.part1Text, answer: body.part1Answer, value: 10 },
					{ bonusId: b.id, partNum: 2, text: body.part2Text, answer: body.part2Answer, value: 10 },
					{ bonusId: b.id, partNum: 3, text: body.part3Text, answer: body.part3Answer, value: 10 },
				],
			});

			return tx.bonus.findUnique({
				where: { id: b.id },
				include: { parts: { orderBy: { partNum: "asc" } } },
			});
		});

		log.info(`POST /sets/${setId}/bonuses — created ${bonus?.id}`);
		return c.json(bonus, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`POST /sets/${setId}/bonuses — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});
