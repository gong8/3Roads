import type { WebSocket } from "ws";
import type { GameRoom } from "./types.js";

/** The 3Roads user behind each game socket, checked at WebSocket upgrade. */
export const socketUsers = new WeakMap<WebSocket, string>();

/** The user ID of a player in this room, if they are still connected. */
export function playerUserId(room: GameRoom, playerId: string): string | undefined {
	const ws = room.players.get(playerId)?.ws;
	return ws && socketUsers.get(ws);
}
