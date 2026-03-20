import { serve } from "@hono/node-server";
import { createLogger, getDb, initDb } from "@3roads/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { foldersRoutes } from "./routes/folders.js";
import { generateRoutes } from "./routes/generate.js";
import { questionsRoutes } from "./routes/questions.js";
import { setsRoutes } from "./routes/sets.js";

const log = createLogger("api");
const routeLog = createLogger("api:routes");

await initDb();

const app = new Hono();

app.use("*", cors());

// Global error handler — catches anything that slips through route-level try/catch
app.onError((err, c) => {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	log.error(`Unhandled error on ${c.req.method} ${c.req.path}: ${message}`, stack ?? err);
	return c.json({ error: message }, 500);
});

app.route("/generate", generateRoutes);
app.route("/sets", setsRoutes);
app.route("/folders", foldersRoutes);
app.route("/questions", questionsRoutes);

// Mount tossup/bonus deletion at root level
app.delete("/tossups/:id", async (c) => {
	const { id } = c.req.param();
	routeLog.info(`DELETE /tossups/${id} — request received`);
	try {
		const db = getDb();

		const tossup = await db.tossup.findUnique({ where: { id } });
		if (!tossup) {
			routeLog.warn(`DELETE /tossups/${id} — tossup not found`);
			return c.json({ error: "Tossup not found" }, 404);
		}

		await db.tossup.delete({ where: { id } });
		routeLog.info(`DELETE /tossups/${id} — deleted`);
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		routeLog.error(`DELETE /tossups/${id} — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

app.delete("/bonuses/:id", async (c) => {
	const { id } = c.req.param();
	routeLog.info(`DELETE /bonuses/${id} — request received`);
	try {
		const db = getDb();

		const bonus = await db.bonus.findUnique({ where: { id } });
		if (!bonus) {
			routeLog.warn(`DELETE /bonuses/${id} — bonus not found`);
			return c.json({ error: "Bonus not found" }, 404);
		}

		await db.bonus.delete({ where: { id } });
		routeLog.info(`DELETE /bonuses/${id} — deleted`);
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		routeLog.error(`DELETE /bonuses/${id} — error: ${message}`, stack ?? err);
		return c.json({ error: message }, 500);
	}
});

app.get("/", (c) => c.json({ name: "3roads-api", version: "0.0.1" }));

const port = Number(process.env.PORT) || 7001;

serve({ fetch: app.fetch, port }, () => {
	log.info(`3Roads API running on http://localhost:${port}`);
});
