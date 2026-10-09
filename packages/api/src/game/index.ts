import type { Server } from "node:http";
import { createLogger } from "@3roads/shared";
import { WebSocketServer } from "ws";
import { accessTokenFromCookieHeader } from "../services/chatgpt-auth.js";
import { socketTokens } from "./judge.js";
import { handleConnection } from "./ws-handler.js";
import { activeRooms } from "./rooms.js";

const log = createLogger("api:game");

export function attachGameWebSocket(server: Server): void {
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url || "/", `http://${request.headers.host}`);

		if (url.pathname === "/ws") {
			wss.handleUpgrade(request, socket, head, (ws) => {
				wss.emit("connection", ws, request);
			});
		} else {
			socket.destroy();
		}
	});

	wss.on("connection", (ws, request) => {
		const auth = accessTokenFromCookieHeader(request.headers.cookie);
		if (auth) socketTokens.set(ws, auth);
		handleConnection(ws);
	});

	log.info("WebSocket server attached at /ws");
}

export function getActiveRoomsList() {
	return Array.from(activeRooms.values()).map((room) => ({
		code: room.code,
		playerCount: room.players.size,
		setName: room.questionSetName,
		phase: room.phase,
		mode: room.mode,
	}));
}
