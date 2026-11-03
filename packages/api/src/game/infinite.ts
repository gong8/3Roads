import { createLogger, getDb } from "@3roads/shared";
import { generateMore, MAX_STYLE_LENGTH, plainAnswer } from "../services/generate-orchestrator.js";
import { canUseModel, defaultModelFor, modelUnavailableMessage } from "../services/llm-chat.js";
import { broadcast, endGame, startTossup } from "./engine.js";
import { toBonusData, toTossupData } from "./rooms.js";
import type { CreateRoomMsg, GameRoom, InfiniteSettings, InfiniteState, InfiniteStatusEvt } from "./types.js";

// Infinite mode: instead of playing a finished set, the room writes questions on a theme in
// small batches while the game runs, staying a few questions ahead of play. Everything written
// is saved to a set owned by the host, so a good run can be replayed later.

const log = createLogger("api:game:infinite");

/** Unplayed tossups to keep written ahead of play; below this another batch starts. */
const READY_TARGET = 3;
/** Questions per batch: big enough to spread each call's fixed cost, small enough to arrive quickly. */
const BATCH_SIZE = 5;
/** Batches in a row that write nothing before the room stops trying. */
const MAX_FAILURES = 3;
const MAX_THEME_LENGTH = 80;

/** Check the host can pay for this run, and create the set its questions are saved into. */
export async function createInfiniteState(
	userId: string | undefined,
	options: NonNullable<CreateRoomMsg["infinite"]>,
	includeBonuses: boolean,
): Promise<InfiniteState> {
	if (!userId) throw new Error("Sign in to play infinite mode");
	const theme = options.theme?.trim().slice(0, MAX_THEME_LENGTH);
	if (!theme) throw new Error("Infinite mode needs a theme");
	const difficulty = options.difficulty || "Regular High School";
	const style = options.style?.trim().slice(0, MAX_STYLE_LENGTH) || undefined;
	const model = options.model || (await defaultModelFor(userId));
	if (!model) throw new Error(modelUnavailableMessage());
	if (!(await canUseModel(userId, model))) throw new Error(modelUnavailableMessage(model));

	const settings: InfiniteSettings = { theme, difficulty, style, model, userId, includeBonuses };
	const set = await getDb().questionSet.create({
		// "generating" while the game runs, so browse shows it filling up
		data: { name: `${theme} (infinite)`, theme, difficulty, ownerId: userId, status: "generating" },
	});
	log.info(`Infinite set ${set.id} created — theme="${theme}" difficulty="${difficulty}" model=${model}`);
	return { ...settings, setId: set.id, cost: null, generating: false, failures: 0, error: null, stopped: false };
}

/** Tossups written but not yet started. */
function queuedTossups(room: GameRoom): number {
	return Math.max(0, room.tossups.length - room.currentQuestionIndex - (room.tossupReading ? 1 : 0));
}

export function infiniteStatus(room: GameRoom): InfiniteStatusEvt | null {
	const inf = room.infinite;
	if (!inf) return null;
	return {
		type: "infinite_status",
		theme: inf.theme,
		difficulty: inf.difficulty,
		model: inf.model,
		cost: inf.cost,
		generating: inf.generating,
		ready: queuedTossups(room),
		written: room.tossups.length,
		error: inf.error,
	};
}

export function broadcastInfiniteStatus(room: GameRoom): void {
	const status = infiniteStatus(room);
	if (status) broadcast(room, status);
}

/** Count OpenRouter spend (generation or judging) towards the room's running total. */
export function addInfiniteCost(room: GameRoom, usd: number): void {
	if (!room.infinite) return;
	room.infinite.cost = (room.infinite.cost ?? 0) + usd;
	broadcastInfiniteStatus(room);
}

/** Whether a room that has run out of questions should wait for more rather than end. */
export function canWriteMore(room: GameRoom): boolean {
	const inf = room.infinite;
	return !!inf && !inf.stopped && (inf.generating || inf.failures < MAX_FAILURES);
}

/** Start another batch if play is getting close to the last written question. */
export function topUpInfinite(room: GameRoom): void {
	const inf = room.infinite;
	if (!inf || inf.stopped || inf.generating || inf.failures >= MAX_FAILURES) return;
	if (queuedTossups(room) >= READY_TARGET) return;
	inf.generating = true;
	broadcastInfiniteStatus(room);
	void writeBatch(room, inf);
}

/** Answers already in the game, which new questions must not repeat. */
function usedAnswers(room: GameRoom): string[] {
	const answers = [
		...room.tossups.map((t) => t.answer),
		...room.bonuses.flatMap((b) => b.parts.map((p) => p.answer)),
	];
	return answers.map(plainAnswer).filter(Boolean);
}

async function writeBatch(room: GameRoom, inf: InfiniteState): Promise<void> {
	log.info(`Room ${room.code} — writing ${BATCH_SIZE} more questions (${room.tossups.length} written so far)`);
	let errors: string[];
	try {
		errors = await generateMore({
			setId: inf.setId,
			theme: inf.theme,
			difficulty: inf.difficulty,
			style: inf.style,
			tossupCount: BATCH_SIZE,
			bonusCount: inf.includeBonuses ? BATCH_SIZE : 0,
			excludeAnswers: usedAnswers(room),
			model: inf.model,
			userId: inf.userId,
			onCost: (usd) => addInfiniteCost(room, usd),
		});
	} catch (err) {
		errors = [err instanceof Error ? err.message : String(err)];
	}

	let added = 0;
	try {
		added = await loadNewQuestions(room, inf);
	} catch (err) {
		errors.push(`Loading new questions failed: ${err instanceof Error ? err.message : err}`);
	}
	inf.generating = false;
	if (errors.length > 0) log.warn(`Room ${room.code} — batch errors: ${errors.join("; ")}`);

	if (added > 0) {
		inf.failures = 0;
		inf.error = null;
	} else {
		inf.failures++;
		inf.error = errors[0] ?? "No questions were written";
	}

	if (inf.stopped) {
		// The game ended while this batch was being written
		await settleSet(inf);
		return;
	}
	await saveCost(inf);
	broadcastInfiniteStatus(room);

	if (room.phase === "waiting_for_questions") {
		if (room.currentQuestionIndex < room.tossups.length) {
			startTossup(room); // tops up again itself
			return;
		}
		if (inf.failures >= MAX_FAILURES) {
			broadcast(room, { type: "error", message: `Couldn't write more questions: ${inf.error}` });
			endGame(room);
			return;
		}
	}
	topUpInfinite(room);
}

/** Append questions saved to the set since the room last looked. Returns how many tossups arrived. */
async function loadNewQuestions(room: GameRoom, inf: InfiniteState): Promise<number> {
	const db = getDb();
	const [tossups, bonuses] = await Promise.all([
		db.tossup.findMany({
			where: { setId: inf.setId, id: { notIn: room.tossups.map((t) => t.id) } },
			orderBy: { createdAt: "asc" },
		}),
		inf.includeBonuses
			? db.bonus.findMany({
					where: { setId: inf.setId, id: { notIn: room.bonuses.map((b) => b.id) } },
					orderBy: { createdAt: "asc" },
					include: { parts: { orderBy: { partNum: "asc" } } },
				})
			: Promise.resolve([]),
	]);
	room.tossups.push(...tossups.map(toTossupData));
	room.bonuses.push(...bonuses.map(toBonusData));
	log.info(`Room ${room.code} — ${tossups.length} tossups and ${bonuses.length} bonuses added (${queuedTossups(room)} ready)`);
	return tossups.length;
}

async function saveCost(inf: InfiniteState): Promise<void> {
	await getDb()
		.questionSet.update({ where: { id: inf.setId }, data: { cost: inf.cost } })
		.catch((err) => log.warn(`Saving cost for ${inf.setId} failed: ${err instanceof Error ? err.message : err}`));
}

/** The game is over: stop writing, and leave the set complete (or gone, if nothing was written). */
export async function stopInfinite(room: GameRoom): Promise<void> {
	const inf = room.infinite;
	if (!inf || inf.stopped) return;
	inf.stopped = true;
	// An in-flight batch still saves its questions; it settles the set when it lands
	if (!inf.generating) await settleSet(inf);
}

async function settleSet(inf: InfiniteState): Promise<void> {
	const db = getDb();
	try {
		const set = await db.questionSet.findUnique({
			where: { id: inf.setId },
			include: { _count: { select: { tossups: true, bonuses: true } } },
		});
		if (!set) return;
		if (set._count.tossups === 0 && set._count.bonuses === 0) {
			await db.questionSet.delete({ where: { id: inf.setId } });
			log.info(`Infinite set ${inf.setId} had no questions — deleted`);
			return;
		}
		await db.questionSet.update({ where: { id: inf.setId }, data: { status: "complete", cost: inf.cost } });
		log.info(`Infinite set ${inf.setId} complete — ${set._count.tossups} tossups, cost=${inf.cost?.toFixed(4) ?? "n/a"}`);
	} catch (err) {
		log.warn(`Settling infinite set ${inf.setId} failed: ${err instanceof Error ? err.message : err}`);
	}
}
