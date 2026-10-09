import { createLogger } from "@3roads/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { AuthError, beginLogin, completeLogin, getAccessToken, logout, status } from "../services/chatgpt-auth.js";
import { DEFAULT_MODEL, listModels } from "../services/llm-chat.js";

const log = createLogger("api:auth");

export const authRoutes = new Hono();

authRoutes.post("/chatgpt/start", (c) => c.json({ url: beginLogin(c) }));

authRoutes.post("/chatgpt/complete", async (c) => {
	const { url } = await c.req.json<{ url?: string }>();
	try {
		return c.json(await completeLogin(c, url ?? ""));
	} catch (err) {
		if (err instanceof AuthError) return c.json({ error: err.message }, 400);
		throw err;
	}
});

// ?minValid=<seconds> refreshes early, e.g. before opening a long-lived game socket.
authRoutes.get("/chatgpt/status", async (c) => {
	const minValid = Number(c.req.query("minValid"));
	return c.json(await status(c, Number.isFinite(minValid) && minValid > 0 ? minValid * 1000 : undefined));
});

authRoutes.post("/chatgpt/logout", async (c) => {
	await logout(c);
	return c.json({ ok: true });
});

authRoutes.get("/models", async (c) => {
	const token = await requireToken(c);
	if (!token) return c.json({ error: "Sign in with ChatGPT first" }, 401);
	try {
		return c.json({ default: DEFAULT_MODEL, models: await listModels(token) });
	} catch (err) {
		log.warn(`GET /auth/models — ${err instanceof Error ? err.message : err}`);
		return c.json({ default: DEFAULT_MODEL, models: [] });
	}
});

/** The caller's ChatGPT access token, or null after which the route should answer 401. */
export async function requireToken(c: Context): Promise<string | null> {
	try {
		return await getAccessToken(c);
	} catch (err) {
		log.warn(`requireToken — ${err instanceof Error ? err.message : err}`);
		return null;
	}
}
