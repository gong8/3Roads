import { createLogger, getDb } from "@3roads/shared";
import { Hono } from "hono";
import { judgeAnswer } from "../game/judge.js";
import { MAX_ANSWERS, MAX_CARDS_PER_ANSWER, runLearnGeneration } from "../services/learn-generator.js";
import { canUseModel, defaultModelFor, modelUnavailableMessage } from "../services/llm-chat.js";
import { currentUser } from "../services/user-auth.js";
import { visibleTo } from "./sets.js";

const log = createLogger("api:routes:learn");

export const learnRoutes = new Hono();

const MAX_LABEL_LENGTH = 40;
const MAX_TOPIC_LENGTH = 80;

const clampInt = (value: unknown, fallback: number, max: number) =>
	Math.min(max, Math.max(1, Math.floor(Number(value) || fallback)));

// Packs this user can see: the public pool plus their own private ones
learnRoutes.get("/", async (c) => {
	const user = currentUser(c);
	const packs = await getDb().learnPack.findMany({
		where: visibleTo(user.id),
		orderBy: { createdAt: "desc" },
		include: { _count: { select: { cards: true } } },
	});
	return c.json(
		packs.map(({ _count, ownerId, ...rest }) => ({ ...rest, mine: ownerId === user.id, cardCount: _count.cards })),
	);
});

learnRoutes.get("/:id", async (c) => {
	const user = currentUser(c);
	const pack = await getDb().learnPack.findFirst({
		where: { id: c.req.param("id"), ...visibleTo(user.id) },
		include: { cards: { orderBy: { createdAt: "asc" } } },
	});
	if (!pack) return c.json({ error: "Pack not found" }, 404);
	const { ownerId, ...rest } = pack;
	return c.json({ ...rest, mine: ownerId === user.id });
});

learnRoutes.post("/", async (c) => {
	const user = currentUser(c);
	const body = await c.req.json<{
		topic?: string;
		promptKind?: string;
		answerKind?: string;
		answerCount?: number;
		cardsPerAnswer?: number;
		model?: string;
	}>();
	const topic = body.topic?.trim().slice(0, MAX_TOPIC_LENGTH);
	const promptKind = body.promptKind?.trim().slice(0, MAX_LABEL_LENGTH);
	const answerKind = body.answerKind?.trim().slice(0, MAX_LABEL_LENGTH);
	if (!topic || !promptKind || !answerKind) return c.json({ error: "topic, prompt and answer are required" }, 400);

	const model = body.model || (await defaultModelFor(user.id));
	if (!model) return c.json({ error: modelUnavailableMessage() }, 400);
	if (!(await canUseModel(user.id, model))) return c.json({ error: modelUnavailableMessage(model) }, 400);

	const answerCount = clampInt(body.answerCount, 20, MAX_ANSWERS);
	const cardsPerAnswer = clampInt(body.cardsPerAnswer, 15, MAX_CARDS_PER_ANSWER);
	const pack = await getDb().learnPack.create({
		data: { name: `${topic}: ${promptKind} → ${answerKind}`, topic, promptKind, answerKind, ownerId: user.id },
	});
	log.info(`POST /learn — pack ${pack.id} "${pack.name}" (${answerCount} × ${cardsPerAnswer}, ${model})`);

	// Fire-and-forget: the pack's status says when it's done
	void runLearnGeneration({ packId: pack.id, topic, promptKind, answerKind, answerCount, cardsPerAnswer, model, userId: user.id });
	return c.json(pack);
});

// Owner-only: rename or make private/public
learnRoutes.patch("/:id", async (c) => {
	const user = currentUser(c);
	const body = await c.req.json<{ name?: string; isPrivate?: boolean }>();
	const data: { name?: string; isPrivate?: boolean } = {};
	if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 120);
	if (typeof body.isPrivate === "boolean") data.isPrivate = body.isPrivate;
	if (Object.keys(data).length === 0) return c.json({ error: "Nothing to update" }, 400);
	const { count } = await getDb().learnPack.updateMany({ where: { id: c.req.param("id"), ownerId: user.id }, data });
	if (count === 0) return c.json({ error: "Pack not found or not yours" }, 404);
	return c.json({ ok: true });
});

learnRoutes.delete("/:id", async (c) => {
	const user = currentUser(c);
	const { count } = await getDb().learnPack.deleteMany({ where: { id: c.req.param("id"), ownerId: user.id } });
	if (count === 0) return c.json({ error: "Pack not found or not yours" }, 404);
	return c.json({ ok: true });
});

// Judge one answer with the local matcher only: drills need instant, free verdicts
learnRoutes.post("/cards/:cardId/judge", async (c) => {
	const user = currentUser(c);
	const { answer } = await c.req.json<{ answer?: string }>();
	const card = await getDb().learnCard.findFirst({
		where: { id: c.req.param("cardId"), pack: visibleTo(user.id) },
	});
	if (!card) return c.json({ error: "Card not found" }, 404);
	const { verdict } = await judgeAnswer(String(answer ?? ""), card.answer, card.prompt, { strictness: 7, aiJudge: false });
	return c.json({ verdict });
});
