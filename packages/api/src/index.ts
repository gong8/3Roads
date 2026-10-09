import "./load-env.js";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { createLogger, getDb, initDb } from "@3roads/shared";
import { Hono } from "hono";
import { attachGameWebSocket, getActiveRoomsList } from "./game/index.js";
import { getAudio } from "./game/tts.js";
import { foldersRoutes } from "./routes/folders.js";
import { generateRoutes } from "./routes/generate.js";
import { meRoutes } from "./routes/me.js";
import { pictureRoundsRoutes } from "./routes/picture-rounds.js";
import { qbreaderRoutes } from "./routes/qbreader.js";
import { setsRoutes } from "./routes/sets.js";
import { requireUser } from "./services/user-auth.js";

const log = createLogger("api");
const routeLog = createLogger("api:routes");

await initDb();

// Generation runs in-process, so any set still "generating" at startup was orphaned
// by a restart (e.g. tsx watch) and will never finish.
const orphaned = await getDb().questionSet.updateMany({
	where: { status: "generating" },
	data: { status: "error" },
});
if (orphaned.count > 0) log.warn(`Marked ${orphaned.count} orphaned generating set(s) as error`);

const app = new Hono();

// The API lives under /api so it never collides with SPA routes like /sets/:id, and all
// of it requires a signed-in (invited) user. Same-origin only, so no CORS headers.
const api = new Hono();
api.use("*", requireUser);

// Global error handler — catches anything that slips through route-level try/catch
app.onError((err, c) => {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	log.error(`Unhandled error on ${c.req.method} ${c.req.path}: ${message}`, stack ?? err);
	return c.json({ error: message }, 500);
});

api.route("/me", meRoutes);
api.route("/generate", generateRoutes);
api.route("/sets", setsRoutes);
api.route("/folders", foldersRoutes);
api.route("/qbreader", qbreaderRoutes);
api.route("/picture-rounds", pictureRoundsRoutes);

// Serve cached TTS audio
api.get("/audio/:id", (c) => {
	const buf = getAudio(c.req.param("id"));
	if (!buf) return c.json({ error: "Not found" }, 404);
	return new Response(buf, {
		headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
	});
});

api.get("/game/rooms", (c) => c.json(getActiveRoomsList()));

app.route("/api", api);

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
