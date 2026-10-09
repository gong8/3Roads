import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";
import { AuthError, beginLogin, completeLogin, connectionStatus, disconnect, getAccessToken } from "../services/chatgpt-auth.js";
import { DEFAULT_MODEL, listModels } from "../services/llm-chat.js";
import { currentUser } from "../services/user-auth.js";

const log = createLogger("api:me");

/** The signed-in user's own settings and history. Mounted at /me. */
export const meRoutes = new Hono();

meRoutes.get("/", (c) => c.json(currentUser(c)));

meRoutes.get("/chatgpt", async (c) => c.json(await connectionStatus(currentUser(c).id)));

meRoutes.post("/chatgpt/start", async (c) => c.json({ url: await beginLogin(currentUser(c).id) }));

meRoutes.post("/chatgpt/complete", async (c) => {
	const { url } = await c.req.json<{ url?: string }>();
	try {
		return c.json(await completeLogin(currentUser(c).id, url ?? ""));
	} catch (err) {
		if (err instanceof AuthError) return c.json({ error: err.message }, 400);
		throw err;
	}
});

meRoutes.delete("/chatgpt", async (c) => {
	await disconnect(currentUser(c).id);
	return c.json({ ok: true });
});

meRoutes.get("/models", async (c) => {
	const token = await getAccessToken(currentUser(c).id).catch(() => null);
	if (!token) return c.json({ default: DEFAULT_MODEL, models: [] });
	try {
		return c.json({ default: DEFAULT_MODEL, models: await listModels(token) });
	} catch (err) {
		log.warn(`GET /me/models — ${err instanceof Error ? err.message : err}`);
		return c.json({ default: DEFAULT_MODEL, models: [] });
	}
});

meRoutes.get("/games", async (c) =>
	c.json(
		await getDb().gameResult.findMany({
			where: { userId: currentUser(c).id },
			orderBy: { createdAt: "desc" },
			take: 50,
		}),
	),
);
