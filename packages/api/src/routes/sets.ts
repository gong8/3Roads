import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";
import { currentUser } from "../services/user-auth.js";

const log = createLogger("api:routes");

export const setsRoutes = new Hono();

/** Sets this user may see: the public pool plus their own private ones. */
export function visibleTo(userId: string) {
	return { OR: [{ isPrivate: false }, { ownerId: userId }] };
}

// List visible sets with question counts
setsRoutes.get("/", async (c) => {
	const user = currentUser(c);
	const sets = await getDb().questionSet.findMany({
		where: visibleTo(user.id),
		orderBy: { createdAt: "desc" },
		include: { _count: { select: { tossups: true, bonuses: true } } },
	});
	// Folders are personal, so only show a folder on the user's own sets.
	const result = sets.map(({ _count, ownerId, folderId, ...rest }) => ({
		...rest,
		folderId: ownerId === user.id ? folderId : null,
		mine: ownerId === user.id,
		tossupCount: _count.tossups,
		bonusCount: _count.bonuses,
	}));
	log.info(`GET /sets — returning ${result.length} sets`);
	return c.json(result);
});

// Get set with all tossups and bonuses (bonuses include parts)
setsRoutes.get("/:id", async (c) => {
	const user = currentUser(c);
	const { id } = c.req.param();
	const set = await getDb().questionSet.findFirst({
		where: { id, ...visibleTo(user.id) },
		include: {
			tossups: { orderBy: { createdAt: "asc" } },
			bonuses: { orderBy: { createdAt: "asc" }, include: { parts: { orderBy: { partNum: "asc" } } } },
		},
	});
	if (!set) return c.json({ error: "Set not found" }, 404);
	const { ownerId, ...rest } = set;
	return c.json({ ...rest, mine: ownerId === user.id });
});

// Owner-only: rename, move to a folder, or make private/public
setsRoutes.patch("/:id", async (c) => {
	const user = currentUser(c);
	const { id } = c.req.param();
	const body = await c.req.json<{ name?: string; theme?: string; folderId?: string | null; isPrivate?: boolean }>();
	const db = getDb();

	const data: Record<string, unknown> = {};
	if (typeof body.name === "string") data.name = body.name;
	if (typeof body.theme === "string") data.theme = body.theme;
	if (typeof body.isPrivate === "boolean") data.isPrivate = body.isPrivate;
	if ("folderId" in body) {
		if (body.folderId) {
			const folder = await db.folder.findFirst({ where: { id: body.folderId, ownerId: user.id } });
			if (!folder) return c.json({ error: "Folder not found" }, 404);
		}
		data.folderId = body.folderId ?? null;
	}
	if (Object.keys(data).length === 0) return c.json({ error: "Nothing to update" }, 400);

	const { count } = await db.questionSet.updateMany({ where: { id, ownerId: user.id }, data });
	if (count === 0) return c.json({ error: "Set not found or not yours" }, 404);
	log.info(`PATCH /sets/${id} — ${JSON.stringify(data)}`);
	return c.json(await db.questionSet.findUnique({ where: { id } }));
});

// Owner-only delete (cascades to questions)
setsRoutes.delete("/:id", async (c) => {
	const user = currentUser(c);
	const { id } = c.req.param();
	const { count } = await getDb().questionSet.deleteMany({ where: { id, ownerId: user.id } });
	if (count === 0) return c.json({ error: "Set not found or not yours" }, 404);
	log.info(`DELETE /sets/${id} — deleted`);
	return c.json({ ok: true });
});
