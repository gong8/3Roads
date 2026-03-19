import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";

const log = createLogger("api");

export const setsRoutes = new Hono();

// List all sets with question counts
setsRoutes.get("/", async (c) => {
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

	log.info(`GET /sets — ${result.length} sets`);
	return c.json(result);
});

// Get set with all tossups and bonuses (bonuses include parts)
setsRoutes.get("/:id", async (c) => {
	const { id } = c.req.param();
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
		return c.json({ error: "Set not found" }, 404);
	}

	log.info(`GET /sets/${id} — ${set.tossups.length} tossups, ${set.bonuses.length} bonuses`);
	return c.json(set);
});

// Create empty set
setsRoutes.post("/", async (c) => {
	const { name, theme } = await c.req.json<{ name: string; theme: string }>();
	const db = getDb();

	if (!name || !theme) {
		return c.json({ error: "name and theme are required" }, 400);
	}

	const set = await db.questionSet.create({
		data: { name, theme },
	});

	log.info(`POST /sets — created ${set.id} "${set.name}"`);
	return c.json(set, 201);
});

// Update name/theme
setsRoutes.patch("/:id", async (c) => {
	const { id } = c.req.param();
	const body = await c.req.json<{ name?: string; theme?: string }>();
	const db = getDb();

	const data: Record<string, string> = {};
	if (body.name) data.name = body.name;
	if (body.theme) data.theme = body.theme;

	if (Object.keys(data).length === 0) {
		return c.json({ error: "Nothing to update" }, 400);
	}

	const set = await db.questionSet.update({
		where: { id },
		data,
	});

	log.info(`PATCH /sets/${id} — updated`);
	return c.json(set);
});

// Delete set (cascade)
setsRoutes.delete("/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	await db.questionSet.delete({ where: { id } });

	log.info(`DELETE /sets/${id}`);
	return c.json({ ok: true });
});

// Save tossup to a set
setsRoutes.post("/:setId/tossups", async (c) => {
	const { setId } = c.req.param();
	const body = await c.req.json<{
		question: string;
		answer: string;
		powerMarkIndex?: number;
		category: string;
		subcategory: string;
		difficulty: string;
	}>();
	const db = getDb();

	const set = await db.questionSet.findUnique({ where: { id: setId } });
	if (!set) {
		return c.json({ error: "Set not found" }, 404);
	}

	if (!body.question || !body.answer || !body.category || !body.subcategory || !body.difficulty) {
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
});

// Save bonus + 3 parts to a set (transaction)
setsRoutes.post("/:setId/bonuses", async (c) => {
	const { setId } = c.req.param();
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
	const db = getDb();

	const set = await db.questionSet.findUnique({ where: { id: setId } });
	if (!set) {
		return c.json({ error: "Set not found" }, 404);
	}

	if (
		!body.leadin ||
		!body.part1Text || !body.part1Answer ||
		!body.part2Text || !body.part2Answer ||
		!body.part3Text || !body.part3Answer ||
		!body.category || !body.subcategory || !body.difficulty
	) {
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
});
