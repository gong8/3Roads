import type { Server } from "node:http";
import { createLogger } from "@3roads/shared";
import { WebSocketServer } from "ws";
import { userFromHeaders } from "../services/user-auth.js";
import { socketUsers } from "./socket-users.js";
import { handleConnection } from "./ws-handler.js";
import { activeRooms } from "./rooms.js";

const log = createLogger("api:game");

export function attachGameWebSocket(server: Server): void {
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (request, socket, head) => {
		const url = new URL(request.url || "/", `http://${request.headers.host}`);

		if (url.pathname !== "/ws") {
			socket.destroy();
			return;
		}
		// Same rule as the HTTP API: only signed-in users may open a game socket.
		// The browser sends Clerk's __session cookie with the upgrade.
		userFromHeaders(undefined, request.headers.cookie)
			.then((user) => {
				if (!user) {
					socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
					return;
				}
				wss.handleUpgrade(request, socket, head, (ws) => {
					socketUsers.set(ws, user.id);
					wss.emit("connection", ws, request);
				});
			})
			.catch(() => socket.destroy());
	});

	wss.on("connection", (ws) => {
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
