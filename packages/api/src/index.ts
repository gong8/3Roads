import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { createLogger, getDb, initDb } from "@3roads/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { attachGameWebSocket, getActiveRoomsList } from "./game/index.js";
import { getAudio } from "./game/tts.js";
import { foldersRoutes } from "./routes/folders.js";
import { generateRoutes } from "./routes/generate.js";
import { pictureRoundsRoutes } from "./routes/picture-rounds.js";
import { qbreaderRoutes } from "./routes/qbreader.js";
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
app.route("/qbreader", qbreaderRoutes);
app.route("/picture-rounds", pictureRoundsRoutes);

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

// Serve cached TTS audio
app.get("/audio/:id", (c) => {
	const buf = getAudio(c.req.param("id"));
	if (!buf) return c.json({ error: "Not found" }, 404);
	return new Response(buf, {
		headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
	});
});

app.get("/game/rooms", (c) => c.json(getActiveRoomsList()));

// --- Static file serving for tunnel/production mode ---
const STATIC_DIR = process.env.SERVE_STATIC;

if (!STATIC_DIR) {
	app.get("/", (c) => c.json({ name: "3roads-api", version: "0.0.1" }));
} else {
	const MIME: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "application/javascript",
		".css": "text/css",
		".json": "application/json",
		".png": "image/png",
		".jpg": "image/jpeg",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
		".woff": "font/woff",
		".woff2": "font/woff2",
		".wasm": "application/wasm",
		".webp": "image/webp",
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
	};

	app.get("*", (c) => {
		const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
		const filePath = join(STATIC_DIR, reqPath);
		try {
			if (existsSync(filePath) && statSync(filePath).isFile()) {
				const content = readFileSync(filePath);
				const mime = MIME[extname(filePath)] || "application/octet-stream";
				return c.body(content, 200, { "Content-Type": mime });
			}
		} catch {}
		// SPA fallback — serve index.html for client-side routing
		const html = readFileSync(join(STATIC_DIR, "index.html"), "utf-8");
		return c.html(html);
	});

	log.info(`Serving static files from ${STATIC_DIR}`);
}

const port = Number(process.env.PORT) || 7001;

// Create HTTP server manually so we can attach WebSocket upgrade handler
// before the Hono request listener (which would 404 on /ws and close the socket)
const server = createServer(getRequestListener(app.fetch));

// Attach WebSocket BEFORE server.listen so upgrade handler is registered first
attachGameWebSocket(server);

server.listen(port, "0.0.0.0", () => {
	log.info(`3Roads API running on http://0.0.0.0:${port}`);
});
