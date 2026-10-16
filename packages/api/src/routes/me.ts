import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";
import { AuthError, beginLogin, completeLogin, connectionStatus, disconnect, getAccessToken } from "../services/chatgpt-auth.js";
import {
	DEFAULT_MODEL,
	DEFAULT_OPENROUTER_MODEL,
	listModels,
	OPENROUTER_MODELS,
	openRouterCredits,
	openRouterEnabled,
} from "../services/llm-chat.js";
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

/**
 * Models this user can pick for generation. `models` are their ChatGPT plan's (empty until
 * connected; `chatgptDefault` is still offered so they can choose it and be asked to connect),
 * `openrouter` are the server-paid ones. `default` prefers ChatGPT when connected.
 */
meRoutes.get("/models", async (c) => {
	const openrouter = openRouterEnabled() ? OPENROUTER_MODELS : [];
	const token = await getAccessToken(currentUser(c).id).catch(() => null);
	let models: { slug: string; name: string }[] = [];
	if (token) {
		try {
			models = await listModels(token);
		} catch (err) {
			log.warn(`GET /me/models — ${err instanceof Error ? err.message : err}`);
		}
	}
	return c.json({
		default: token || openrouter.length === 0 ? DEFAULT_MODEL : DEFAULT_OPENROUTER_MODEL,
		chatgptConnected: !!token,
		chatgptDefault: DEFAULT_MODEL,
		models,
		openrouter,
	});
});

/** The server's OpenRouter balance, which pays for OpenRouter models. `enabled: false` when there's no key. */
meRoutes.get("/openrouter", async (c) => {
	if (!openRouterEnabled()) return c.json({ enabled: false });
	try {
		return c.json({ enabled: true, ...(await openRouterCredits()) });
	} catch (err) {
		log.warn(`GET /me/openrouter — ${err instanceof Error ? err.message : err}`);
		return c.json({ enabled: true, error: "Couldn't reach OpenRouter" });
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
