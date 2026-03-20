import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";

const log = createLogger("api:folders");

export const foldersRoutes = new Hono();

// List all folders with set counts
foldersRoutes.get("/", async (c) => {
	log.info("GET /folders — request received");
	try {
		const db = getDb();
		const folders = await db.folder.findMany({
			orderBy: { name: "asc" },
			include: {
				_count: { select: { sets: true } },
			},
		});

		const result = folders.map(({ _count, ...rest }) => ({
			...rest,
			setCount: _count.sets,
		}));

		log.info(`GET /folders — returning ${result.length} folders`);
		return c.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error(`GET /folders — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});

// Create folder
foldersRoutes.post("/", async (c) => {
	log.info("POST /folders — request received");
	try {
		const { name } = await c.req.json<{ name: string }>();
		const trimmed = name?.trim();
		if (!trimmed) {
			return c.json({ error: "name is required" }, 400);
		}

		const db = getDb();
		const folder = await db.folder.create({ data: { name: trimmed } });

		log.info(`POST /folders — created ${folder.id} "${folder.name}"`);
		return c.json(folder, 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("Unique constraint")) {
			return c.json({ error: "A folder with that name already exists" }, 409);
		}
		log.error(`POST /folders — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});

// Rename folder
foldersRoutes.patch("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`PATCH /folders/${id} — request received`);
	try {
		const { name } = await c.req.json<{ name: string }>();
		const trimmed = name?.trim();
		if (!trimmed) {
			return c.json({ error: "name is required" }, 400);
		}

		const db = getDb();
		const folder = await db.folder.update({
			where: { id },
			data: { name: trimmed },
		});

		log.info(`PATCH /folders/${id} — renamed to "${folder.name}"`);
		return c.json(folder);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("P2025")) {
			return c.json({ error: "Folder not found" }, 404);
		}
		if (message.includes("Unique constraint")) {
			return c.json({ error: "A folder with that name already exists" }, 409);
		}
		log.error(`PATCH /folders/${id} — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});

// Delete folder (sets become unfiled)
foldersRoutes.delete("/:id", async (c) => {
	const { id } = c.req.param();
	log.info(`DELETE /folders/${id} — request received`);
	try {
		const db = getDb();
		await db.folder.delete({ where: { id } });

		log.info(`DELETE /folders/${id} — deleted`);
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("P2025")) {
			return c.json({ error: "Folder not found" }, 404);
		}
		log.error(`DELETE /folders/${id} — error: ${message}`);
		return c.json({ error: message }, 500);
	}
});
