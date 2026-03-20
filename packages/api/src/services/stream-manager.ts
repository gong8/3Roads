import { createLogger } from "@3roads/shared";
import { LineBuffer } from "./line-buffer.js";

const log = createLogger("api:stream");

interface BufferedEvent {
	event: string;
	data: string;
}

type Subscriber = (event: string, data: string) => void;

export interface ActiveStream {
	setId: string;
	events: BufferedEvent[];
	status: "streaming" | "complete" | "error";
	subscribers: Set<Subscriber>;
	done: Promise<void>;
}

const CLEANUP_DELAY_MS = 60_000;

const activeStreams = new Map<string, ActiveStream>();

function parseSSELine(
	line: string,
	currentEventType: { value: string },
): { type: string; data: string } | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith("event: ")) {
		currentEventType.value = trimmed.slice(7);
		return null;
	}

	if (!trimmed.startsWith("data: ")) return null;
	const data = trimmed.slice(6);
	const type = currentEventType.value;
	currentEventType.value = "content";
	return { type, data };
}

function createEmitter(stream: ActiveStream): (event: string, data: string) => void {
	return (event, data) => {
		stream.events.push({ event, data });
		for (const cb of stream.subscribers) {
			try {
				cb(event, data);
			} catch (err) {
				log.warn(`stream-manager — subscriber callback error for set ${stream.setId}: ${err instanceof Error ? err.message : err}`);
			}
		}
	};
}

function scheduleCleanup(setId: string): void {
	setTimeout(() => {
		activeStreams.delete(setId);
		log.info(`stream-manager — cleaned up stream for set ${setId}`);
	}, CLEANUP_DELAY_MS);
}

async function consumeStream(
	stream: ActiveStream,
	cliStream: ReadableStream<Uint8Array>,
	emit: (event: string, data: string) => void,
): Promise<void> {
	const reader = cliStream.getReader();
	const decoder = new TextDecoder();
	const lineBuffer = new LineBuffer();
	const currentEventType = { value: "content" };
	let status: "complete" | "error" = "complete";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;

			for (const line of lineBuffer.push(decoder.decode(value, { stream: true }))) {
				const parsed = parseSSELine(line, currentEventType);
				if (!parsed || parsed.data === "[DONE]") continue;

				try {
					const obj = JSON.parse(parsed.data);
					log.debug(`consumeStream [${stream.setId}] — SSE event: ${parsed.type}`);
					emit(parsed.type, JSON.stringify(obj));
				} catch (err) {
					log.warn(`consumeStream [${stream.setId}] — unparseable SSE data: ${err instanceof Error ? err.message : err} — raw: ${parsed.data.slice(0, 200)}`);
				}
			}
		}
	} catch (error) {
		log.error("stream-manager — streaming error", error);
		status = "error";
	} finally {
		reader.releaseLock();
	}

	stream.status = status;
	log.info(`consumeStream [${stream.setId}] — finished with status=${status}, total events=${stream.events.length}`);
	if (status === "error") {
		emit("error", JSON.stringify({ error: "Stream failed" }));
	}
	emit("done", "[DONE]");
	scheduleCleanup(stream.setId);
}

export function startStream(
	setId: string,
	cliStream: ReadableStream<Uint8Array>,
): ActiveStream {
	const existing = activeStreams.get(setId);
	if (existing && existing.status === "streaming") {
		log.warn(`stream-manager — stream already active for set ${setId}, returning existing`);
		return existing;
	}

	const stream: ActiveStream = {
		setId,
		events: [],
		status: "streaming",
		subscribers: new Set(),
		done: Promise.resolve(),
	};

	stream.done = consumeStream(stream, cliStream, createEmitter(stream));

	activeStreams.set(setId, stream);
	log.info(`stream-manager — started stream for set ${setId}`);
	return stream;
}

export function getStream(setId: string): ActiveStream | undefined {
	return activeStreams.get(setId);
}

export interface SubscribeHandle {
	unsubscribe: () => void;
	delivered: Promise<void>;
}

function createEventQueue(cb: Subscriber, onDrained: () => void) {
	const queue: BufferedEvent[] = [];
	let draining = false;
	let active = true;

	async function drain() {
		if (draining) return;
		draining = true;
		while (queue.length > 0 && active) {
			const evt = queue.shift();
			if (!evt) break;
			try {
				await cb(evt.event, evt.data);
			} catch (err) {
				log.warn(`createEventQueue — subscriber callback error: ${err instanceof Error ? err.message : err}`);
			}
		}
		draining = false;
		onDrained();
	}

	return {
		enqueue(event: string, data: string) {
			queue.push({ event, data });
			drain();
		},
		stop() {
			active = false;
		},
		get isEmpty() {
			return queue.length === 0;
		},
	};
}

export function subscribe(setId: string, cb: Subscriber): SubscribeHandle | null {
	const stream = activeStreams.get(setId);
	if (!stream) {
		log.warn(`subscribe — no active stream found for set ${setId}`);
		return null;
	}

	let resolveDelivered: () => void;
	const delivered = new Promise<void>((resolve) => {
		resolveDelivered = resolve;
	});

	const eq = createEventQueue(cb, () => {
		if (stream.status !== "streaming" && eq.isEmpty) resolveDelivered();
	});

	const replayCount = stream.events.length;
	for (const { event, data } of stream.events) {
		eq.enqueue(event, data);
	}

	log.info(`subscribe [${setId}] — new subscriber, replaying ${replayCount} buffered events, stream status=${stream.status}`);

	if (stream.status === "streaming") {
		stream.subscribers.add(eq.enqueue);
	}

	return {
		unsubscribe: () => {
			eq.stop();
			stream.subscribers.delete(eq.enqueue);
			resolveDelivered();
		},
		delivered,
	};
}
