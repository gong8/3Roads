// In dev, Vite proxy doesn't reliably forward WS upgrades, so connect directly to API
const DEV_API_WS = `ws://${window.location.hostname}:7001/ws`;
const PROD_WS =
	window.location.protocol === "https:"
		? `wss://${window.location.host}/ws`
		: `ws://${window.location.host}/ws`;
const WS_URL = import.meta.env.DEV ? DEV_API_WS : PROD_WS;

export interface GameSocket {
	send: (msg: Record<string, unknown>) => void;
	onMessage: (cb: (msg: Record<string, unknown>) => void) => void;
	onClose: (cb: () => void) => void;
	close: () => void;
	ready: Promise<void>;
}

export function createGameSocket(): GameSocket {
	console.log("[3roads:ws] connecting to", WS_URL);
	const ws = new WebSocket(WS_URL);
	let messageHandler: ((msg: Record<string, unknown>) => void) | null = null;
	let closeHandler: (() => void) | null = null;
	let closed = false;

	const ready = new Promise<void>((resolve, reject) => {
		ws.onopen = () => {
			console.log("[3roads:ws] connected");
			resolve();
		};
		ws.onerror = (e) => {
			if (closed) return;
			console.error("[3roads:ws] error", e);
			reject(e);
		};
	});

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data);
			console.log("[3roads:ws] recv", msg.type);
			if (messageHandler) messageHandler(msg);
		} catch (err) {
			console.error("[3roads:ws] parse error", err);
		}
	};

	ws.onclose = () => {
		if (closed) return;
		console.log("[3roads:ws] disconnected");
		if (closeHandler) closeHandler();
	};

	return {
		send(msg) {
			if (ws.readyState !== WebSocket.OPEN) return;
			console.log("[3roads:ws] send", msg.type);
			ws.send(JSON.stringify(msg));
		},
		onMessage(cb) {
			messageHandler = cb;
		},
		onClose(cb) {
			closeHandler = cb;
		},
		close() {
			closed = true;
			ws.close();
		},
		ready,
	};
}
