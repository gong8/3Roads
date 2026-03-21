import { createLogger } from "@3roads/shared";
import type { WebSocket } from "ws";
import {
	broadcast,
	broadcastPlayerList,
	endGame,
	handleAnswer,
	handleAudioReady,
	handleBonusAnswer,
	handleBonusBuzz,
	handleBuzz,
	nextQuestion,
	sendTo,
	skipQuestion,
	pregenerateTTS,
	startGame,
} from "./engine.js";
import {
	activeRooms,
	createRoom,
	disconnectPlayer,
	joinRoom,
	reconnectPlayer,
	removePlayer,
} from "./rooms.js";
import type { ClientMessage, GameRoom, ServerMessage } from "./types.js";

const log = createLogger("api:game:ws");

// Map from WebSocket to player context
const wsContext = new Map<WebSocket, { roomCode: string; playerId: string }>();

export async function handleConnection(ws: WebSocket): Promise<void> {
	log.info("New WebSocket connection");

	ws.on("message", async (data) => {
		try {
			const msg = JSON.parse(data.toString()) as ClientMessage;
			await routeMessage(ws, msg);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(`ws-handler — message error: ${message}`);
			sendRaw(ws, { type: "error", message });
		}
	});

	ws.on("close", () => {
		const ctx = wsContext.get(ws);
		if (ctx) {
			const player = disconnectPlayer(ctx.roomCode, ctx.playerId);
			if (player) {
				const room = activeRooms.get(ctx.roomCode);
				if (room) {
					broadcast(room, {
						type: "player_disconnected",
						playerId: ctx.playerId,
						playerName: player.name,
					});
					broadcastPlayerList(room);
				}
			}
			wsContext.delete(ws);
		}
	});
}

function sendRaw(ws: WebSocket, msg: ServerMessage): void {
	try {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	} catch {
		// ignore
	}
}

async function routeMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
	switch (msg.type) {
		case "create_room":
			await handleCreateRoom(ws, msg.questionSetId, msg.playerName, msg.mode, msg.ttsEnabled);
			break;
		case "join_room":
			await handleJoinRoom(ws, msg.roomCode, msg.playerName);
			break;
		case "start_game":
			handleStartGame(ws);
			break;
		case "buzz":
			handleBuzzMsg(ws);
			break;
		case "submit_answer":
			await handleSubmitAnswer(ws, msg.answer);
			break;
		case "submit_bonus_answer":
			await handleSubmitBonusAnswer(ws, msg.answer);
			break;
		case "next_question":
			handleNextQuestion(ws);
			break;
		case "skip":
			handleSkip(ws);
			break;
		case "end_game":
			handleEndGame(ws);
			break;
		case "kick_player":
			handleKickPlayer(ws, msg.playerId);
			break;
		case "set_team":
			handleSetTeam(ws, msg.playerId, msg.team);
			break;
		case "audio_ready":
			handleAudioReadyMsg(ws);
			break;
		case "update_settings":
			handleUpdateSettings(ws, msg);
			break;
		default:
			sendRaw(ws, { type: "error", message: "Unknown message type" });
	}
}

async function handleCreateRoom(
	ws: WebSocket,
	questionSetId: string,
	playerName: string,
	mode: "ffa" | "teams",
	ttsEnabled?: boolean,
): Promise<void> {
	const { room, playerId } = await createRoom(questionSetId, playerName, mode, ws, ttsEnabled ?? false);
	wsContext.set(ws, { roomCode: room.code, playerId });
	sendRaw(ws, { type: "room_created", roomCode: room.code, playerId });
	broadcastPlayerList(room);

	// Fire-and-forget: start TTS pregeneration in background
	if (room.settings.ttsEnabled) {
		pregenerateTTS(room).catch(() => {});
	}
}

async function handleJoinRoom(
	ws: WebSocket,
	roomCode: string,
	playerName: string,
): Promise<void> {
	// Try reconnecting first
	const reconnected = reconnectPlayer(roomCode, playerName, ws);
	if (reconnected) {
		const { room, playerId } = reconnected;
		wsContext.set(ws, { roomCode, playerId });
		sendRaw(ws, { type: "room_joined", roomCode, playerId });
		broadcast(room, { type: "player_reconnected", playerId, playerName });
		broadcastPlayerList(room);
		// Send current phase so reconnected player can catch up
		sendRaw(ws, { type: "phase_change", phase: room.phase });
		return;
	}

	const { room, playerId } = joinRoom(roomCode, playerName, ws);
	wsContext.set(ws, { roomCode, playerId });
	sendRaw(ws, { type: "room_joined", roomCode, playerId });
	broadcastPlayerList(room);
}

function getContext(ws: WebSocket): { room: GameRoom; playerId: string } | null {
	const ctx = wsContext.get(ws);
	if (!ctx) return null;
	const room = activeRooms.get(ctx.roomCode);
	if (!room) return null;
	return { room, playerId: ctx.playerId };
}

function requireModerator(ws: WebSocket): { room: GameRoom; playerId: string } | null {
	const ctx = getContext(ws);
	if (!ctx) {
		sendRaw(ws, { type: "error", message: "Not in a room" });
		return null;
	}
	const player = ctx.room.players.get(ctx.playerId);
	if (!player?.isModerator) {
		sendRaw(ws, { type: "error", message: "Only the host can do that" });
		return null;
	}
	return ctx;
}

function handleAudioReadyMsg(ws: WebSocket): void {
	const ctx = getContext(ws);
	if (!ctx) return;
	handleAudioReady(ctx.room);
}

function handleStartGame(ws: WebSocket): void {
	const ctx = requireModerator(ws);
	if (!ctx) return;

	if (ctx.room.phase !== "lobby") {
		sendRaw(ws, { type: "error", message: "Game already started" });
		return;
	}

	startGame(ctx.room);
}

function handleBuzzMsg(ws: WebSocket): void {
	const ctx = getContext(ws);
	if (!ctx) return;
	if (ctx.room.phase === "reading_bonus") {
		handleBonusBuzz(ctx.room, ctx.playerId);
	} else {
		handleBuzz(ctx.room, ctx.playerId);
	}
}

async function handleSubmitAnswer(ws: WebSocket, answer: string): Promise<void> {
	const ctx = getContext(ws);
	if (!ctx) return;
	await handleAnswer(ctx.room, ctx.playerId, answer);
}

async function handleSubmitBonusAnswer(ws: WebSocket, answer: string): Promise<void> {
	const ctx = getContext(ws);
	if (!ctx) return;

	const br = ctx.room.bonusReading;
	if (!br) return;

	// In FFA, only the controlling player can answer. In teams, any teammate can answer
	// but the controlling player submits.
	if (ctx.room.mode === "ffa") {
		if (br.controllingPlayerId !== ctx.playerId) {
			sendRaw(ws, { type: "error", message: "Only the controlling player can answer bonus" });
			return;
		}
	} else {
		// Team mode: only teammates of the controlling player can answer
		const controlling = ctx.room.players.get(br.controllingPlayerId);
		const current = ctx.room.players.get(ctx.playerId);
		if (controlling?.team !== current?.team) {
			sendRaw(ws, { type: "error", message: "Only the controlling team can answer" });
			return;
		}
	}

	await handleBonusAnswer(ctx.room, answer);
}

function handleNextQuestion(ws: WebSocket): void {
	const ctx = requireModerator(ws);
	if (!ctx) return;
	nextQuestion(ctx.room);
}

function handleSkip(ws: WebSocket): void {
	const ctx = requireModerator(ws);
	if (!ctx) return;
	skipQuestion(ctx.room);
}

function handleEndGame(ws: WebSocket): void {
	const ctx = requireModerator(ws);
	if (!ctx) return;
	endGame(ctx.room);
}

function handleKickPlayer(ws: WebSocket, targetPlayerId: string): void {
	const ctx = requireModerator(ws);
	if (!ctx) return;

	const target = ctx.room.players.get(targetPlayerId);
	if (!target) return;
	if (target.isModerator) {
		sendRaw(ws, { type: "error", message: "Cannot kick the host" });
		return;
	}

	sendTo(target, { type: "player_kicked", playerId: targetPlayerId, playerName: target.name });
	target.ws.close();
	removePlayer(ctx.room.code, targetPlayerId);
	broadcast(ctx.room, { type: "player_kicked", playerId: targetPlayerId, playerName: target.name });
	broadcastPlayerList(ctx.room);
}

function handleUpdateSettings(ws: WebSocket, msg: { strictness?: number; msPerWord?: number }): void {
	const ctx = requireModerator(ws);
	if (!ctx) return;

	if (msg.strictness != null) {
		ctx.room.settings.strictness = Math.max(1, Math.min(10, Math.round(msg.strictness)));
	}
	if (msg.msPerWord != null) {
		ctx.room.settings.msPerWord = Math.max(100, Math.min(500, Math.round(msg.msPerWord)));
	}
}

function handleSetTeam(ws: WebSocket, targetPlayerId: string, team: "a" | "b"): void {
	const ctx = requireModerator(ws);
	if (!ctx) return;

	if (ctx.room.mode !== "teams") {
		sendRaw(ws, { type: "error", message: "Not in team mode" });
		return;
	}
	if (ctx.room.phase !== "lobby") {
		sendRaw(ws, { type: "error", message: "Cannot change teams after game starts" });
		return;
	}

	const target = ctx.room.players.get(targetPlayerId);
	if (!target) return;

	target.team = team;
	broadcastPlayerList(ctx.room);
}
