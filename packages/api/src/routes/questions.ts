import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";

const log = createLogger("api:routes");

export const questionsRoutes = new Hono();

// Search questions by query text, category, type, limit
// Mounted at /questions, so this handles GET /questions/search
questionsRoutes.get("/search", async (c) => {
	log.info("GET /questions/search — request received");
	try {
		const query = c.req.query("q") || "";
		const category = c.req.query("category");
		const type = c.req.query("type"); // "tossup" | "bonus"
		const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
		const db = getDb();

		log.info(`GET /questions/search — params: q="${query}" category="${category}" type="${type}" limit=${limit}`);

		if (!query) {
			log.warn("GET /questions/search — missing required q parameter");
			return c.json({ error: "q parameter is required" }, 400);
		}

		const results: { tossups: unknown[]; bonuses: unknown[] } = {
			tossups: [],
			bonuses: [],
		};

		if (!type || type === "tossup") {
			results.tossups = await db.tossup.findMany({
				where: {
					AND: [
						{
							OR: [
								{ question: { contains: query } },
								{ answer: { contains: query } },
							],
						},
						...(category ? [{ category }] : []),
					],
				},
				take: limit,
				orderBy: { createdAt: "desc" },
				include: { set: { select: { id: true, name: true } } },
			});
		}

		if (!type || type === "bonus") {
			results.bonuses = await db.bonus.findMany({
				where: {
					AND: [
						{
							OR: [
								{ leadin: { contains: query } },
								{ parts: { some: { text: { contains: query } } } },
								{ parts: { some: { answer: { contains: query } } } },
							],
						},
						...(category ? [{ category }] : []),
					],
				},
				take: limit,
				orderBy: { createdAt: "desc" },
				include: {
					set: { select: { id: true, name: true } },
					parts: { orderBy: { partNum: "asc" } },
				},
			});
		}

		log.info(`GET /questions/search?q=${query} — ${results.tossups.length} tossups, ${results.bonuses.length} bonuses`);
		return c.json(results);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		log.error(`GET /questions/search — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});
