import { createLogger, getDb } from "@3roads/shared";
import type { WebSocket } from "ws";
import type { BonusData, GameMode, GameRoom, Player, TossupData } from "./types.js";

const log = createLogger("api:game:rooms");

export const activeRooms = new Map<string, GameRoom>();

// Track disconnected players for reconnection grace period
const disconnectedPlayers = new Map<
	string,
	{ roomCode: string; player: Player; timeout: ReturnType<typeof setTimeout> }
>();

function generateRoomCode(): string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
	for (let attempt = 0; attempt < 100; attempt++) {
		let code = "";
		for (let i = 0; i < 4; i++) {
			code += chars[Math.floor(Math.random() * chars.length)];
		}
		if (!activeRooms.has(code)) return code;
	}
	throw new Error("Failed to generate unique room code");
}

function generatePlayerId(): string {
	return Math.random().toString(36).slice(2, 10);
}

export async function createRoom(
	questionSetId: string,
	playerName: string,
	mode: GameMode,
	ws: WebSocket,
	ttsEnabled = false,
): Promise<{ room: GameRoom; playerId: string }> {
	const db = getDb();
	const set = await db.questionSet.findUnique({
		where: { id: questionSetId },
		include: {
			tossups: { orderBy: { createdAt: "asc" } },
			bonuses: {
				orderBy: { createdAt: "asc" },
				include: { parts: { orderBy: { partNum: "asc" } } },
			},
		},
	});

	if (!set) throw new Error("Question set not found");
	if (set.tossups.length === 0) throw new Error("Question set has no tossups");

	const tossups: TossupData[] = set.tossups.map((t) => ({
		id: t.id,
		question: t.question,
		answer: t.answer,
		powerMarkIndex: t.powerMarkIndex,
		category: t.category,
		subcategory: t.subcategory,
		difficulty: t.difficulty,
	}));

	const bonuses: BonusData[] = set.bonuses.map((b) => ({
		id: b.id,
		leadin: b.leadin,
		category: b.category,
		subcategory: b.subcategory,
		difficulty: b.difficulty,
		parts: b.parts.map((p) => ({
			partNum: p.partNum,
			text: p.text,
			answer: p.answer,
			value: p.value,
		})),
	}));

	const code = generateRoomCode();
	const playerId = generatePlayerId();

	const player: Player = {
		id: playerId,
		name: playerName,
		ws,
		score: 0,
		powers: 0,
		tens: 0,
		negs: 0,
		isModerator: true,
		team: mode === "teams" ? "a" : undefined,
	};

	const room: GameRoom = {
		code,
		questionSetId,
		questionSetName: set.name,
		mode,
		players: new Map([[playerId, player]]),
		phase: "lobby",
		tossups,
		bonuses,
		currentQuestionIndex: 0,
		tossupReading: null,
		bonusReading: null,
		settings: {
			msPerWord: 300,
			answerTimeMs: 8000,
			bonusAnswerTimeMs: 10000,
			strictness: 7,
			ttsEnabled,
		},
		lastActivity: Date.now(),
		answerTimer: null,
		ttsCache: new Map(),
		pendingAudioReady: null,
		audioReadyTimeout: null,
	};

	activeRooms.set(code, room);
	log.info(`Room ${code} created by "${playerName}" — set="${set.name}" mode=${mode} tossups=${tossups.length} bonuses=${bonuses.length}`);

	return { room, playerId };
}

export function joinRoom(
	roomCode: string,
	playerName: string,
	ws: WebSocket,
): { room: GameRoom; playerId: string } {
	const room = activeRooms.get(roomCode);
	if (!room) throw new Error("Room not found");
	if (room.phase !== "lobby") throw new Error("Game already in progress");

	const playerId = generatePlayerId();
	const player: Player = {
		id: playerId,
		name: playerName,
		ws,
		score: 0,
		powers: 0,
		tens: 0,
		negs: 0,
		isModerator: false,
		team: room.mode === "teams" ? "b" : undefined,
	};

	room.players.set(playerId, player);
	room.lastActivity = Date.now();
	log.info(`Room ${roomCode} — "${playerName}" joined (${playerId}), ${room.players.size} players`);

	return { room, playerId };
}

export function reconnectPlayer(
	roomCode: string,
	playerName: string,
	ws: WebSocket,
): { room: GameRoom; playerId: string } | null {
	// Check disconnected players first
	for (const [key, disc] of disconnectedPlayers) {
		if (disc.roomCode === roomCode && disc.player.name === playerName) {
			clearTimeout(disc.timeout);
			disconnectedPlayers.delete(key);
			const room = activeRooms.get(roomCode);
			if (!room) return null;
			disc.player.ws = ws;
			room.players.set(disc.player.id, disc.player);
			room.lastActivity = Date.now();
			log.info(`Room ${roomCode} — "${playerName}" reconnected (grace period) as ${disc.player.id}`);
			return { room, playerId: disc.player.id };
		}
	}
	return null;
}

export function removePlayer(roomCode: string, playerId: string): void {
	const room = activeRooms.get(roomCode);
	if (!room) return;

	const player = room.players.get(playerId);
	if (!player) return;

	room.players.delete(playerId);
	room.lastActivity = Date.now();

	log.info(`Room ${roomCode} — "${player.name}" removed, ${room.players.size} remaining`);

	if (room.players.size === 0) {
		cleanupRoom(roomCode);
		return;
	}

	// Promote new host if needed
	if (player.isModerator) {
		const next = room.players.values().next().value;
		if (next) {
			next.isModerator = true;
			log.info(`Room ${roomCode} — "${next.name}" promoted to moderator`);
		}
	}
}

export function disconnectPlayer(roomCode: string, playerId: string): Player | null {
	const room = activeRooms.get(roomCode);
	if (!room) return null;

	const player = room.players.get(playerId);
	if (!player) return null;

	room.players.delete(playerId);

	// Grace period for reconnection
	const key = `${roomCode}:${playerId}`;
	const timeout = setTimeout(() => {
		disconnectedPlayers.delete(key);
		// If the player never came back, do full removal
		const r = activeRooms.get(roomCode);
		if (r && r.players.size === 0) {
			cleanupRoom(roomCode);
		} else if (r && player.isModerator) {
			const next = r.players.values().next().value;
			if (next) {
				next.isModerator = true;
				log.info(`Room ${roomCode} — "${next.name}" promoted to moderator (after disconnect timeout)`);
			}
		}
	}, 10_000);

	disconnectedPlayers.set(key, { roomCode, player, timeout });
	log.info(`Room ${roomCode} — "${player.name}" disconnected, 10s grace period`);
	return player;
}

function cleanupRoom(roomCode: string): void {
	const room = activeRooms.get(roomCode);
	if (!room) return;

	if (room.tossupReading?.intervalHandle) {
		clearInterval(room.tossupReading.intervalHandle);
	}
	if (room.answerTimer) {
		clearTimeout(room.answerTimer);
	}

	activeRooms.delete(roomCode);
	log.info(`Room ${roomCode} cleaned up`);
}

// Periodic cleanup
setInterval(() => {
	const now = Date.now();
	for (const [code, room] of activeRooms) {
		const idle = now - room.lastActivity;
		if (room.players.size === 0 || (room.phase === "game_over" && idle > 5 * 60_000) || idle > 30 * 60_000) {
			cleanupRoom(code);
		}
	}
}, 60_000);
