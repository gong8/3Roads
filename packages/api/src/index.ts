import { serve } from "@hono/node-server";
import { createLogger, getDb, initDb } from "@3roads/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { generateRoutes } from "./routes/generate.js";
import { questionsRoutes } from "./routes/questions.js";
import { setsRoutes } from "./routes/sets.js";

const log = createLogger("api");

await initDb();

const app = new Hono();

app.use("*", cors());

app.route("/generate", generateRoutes);
app.route("/sets", setsRoutes);
app.route("/questions", questionsRoutes);

// Mount tossup/bonus deletion at root level
app.delete("/tossups/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	const tossup = await db.tossup.findUnique({ where: { id } });
	if (!tossup) {
		return c.json({ error: "Tossup not found" }, 404);
	}

	await db.tossup.delete({ where: { id } });
	log.info(`DELETE /tossups/${id}`);
	return c.json({ ok: true });
});

app.delete("/bonuses/:id", async (c) => {
	const { id } = c.req.param();
	const db = getDb();

	const bonus = await db.bonus.findUnique({ where: { id } });
	if (!bonus) {
		return c.json({ error: "Bonus not found" }, 404);
	}

	await db.bonus.delete({ where: { id } });
	log.info(`DELETE /bonuses/${id}`);
	return c.json({ ok: true });
});

app.get("/", (c) => c.json({ name: "3roads-api", version: "0.0.1" }));

const port = Number(process.env.PORT) || 8787;

serve({ fetch: app.fetch, port }, () => {
	log.info(`3Roads API running on http://localhost:${port}`);
});
