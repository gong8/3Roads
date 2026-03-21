import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createLogger } from "@3roads/shared";

const log = createLogger("api:game:tts");

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(__dirname, "../../../../data/models/kokoro-82m-timestamped");
import { existsSync } from "node:fs";
const WORKER_TS = resolve(__dirname, "tts-worker.ts");
const WORKER_JS = resolve(__dirname, "tts-worker.js");
const WORKER_PATH = existsSync(WORKER_TS) ? WORKER_TS : WORKER_JS;

// In-memory audio cache with auto-cleanup
const audioCache = new Map<string, { buffer: Buffer; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateId(): string {
	return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export function storeAudio(buf: Buffer): string {
	const id = generateId();
	audioCache.set(id, { buffer: buf, expires: Date.now() + CACHE_TTL_MS });
	return id;
}

export function getAudio(id: string): Buffer | undefined {
	const entry = audioCache.get(id);
	if (!entry) return undefined;
	if (Date.now() > entry.expires) {
		audioCache.delete(id);
		return undefined;
	}
	return entry.buffer;
}

export function deleteAudio(id: string): void {
	audioCache.delete(id);
}

// Periodic cleanup of expired entries
setInterval(() => {
	const now = Date.now();
	for (const [id, entry] of audioCache) {
		if (now > entry.expires) {
			audioCache.delete(id);
		}
	}
}, 60_000);

// Worker pool TTS
const POOL_SIZE = 10;

type TtsResult = { wav: Buffer; durationMs: number; wordDelays: number[] | null };

interface PoolWorker {
	worker: Worker;
	busy: boolean;
	pending: Map<number, { resolve: (v: TtsResult) => void; reject: (e: Error) => void }>;
}

let pool: PoolWorker[] = [];
let poolReady: Promise<void> | null = null;
let nextId = 0;
const queue: Array<{ id: number; text: string; words: string[]; resolve: (v: TtsResult) => void; reject: (e: Error) => void }> = [];

function spawnWorker(index: number): Promise<PoolWorker> {
	return new Promise((resolveReady, rejectReady) => {
		const isTsFile = WORKER_PATH.endsWith(".ts");
		const w = new Worker(WORKER_PATH, {
			workerData: { modelDir: MODEL_DIR },
			...(isTsFile ? { execArgv: ["--import", "tsx"] } : {}),
		});

		const pw: PoolWorker = { worker: w, busy: false, pending: new Map() };

		w.on("message", (msg: any) => {
			if (msg.type === "ready") {
				log.info(`TTS worker ${index} ready`);
				resolveReady(pw);
				return;
			}
			if (msg.type === "result") {
				const p = pw.pending.get(msg.id);
				if (p) {
					pw.pending.delete(msg.id);
					pw.busy = false;
					p.resolve({ wav: msg.wav, durationMs: msg.durationMs, wordDelays: msg.wordDelays ?? null });
					drainQueue();
				}
			}
			if (msg.type === "error" && msg.id != null) {
				const p = pw.pending.get(msg.id);
				if (p) {
					pw.pending.delete(msg.id);
					pw.busy = false;
					p.reject(new Error(msg.message));
					drainQueue();
				}
			}
		});

		w.on("error", (err) => {
			log.error(`TTS worker ${index} error: ${err.message}`);
			rejectReady(err);
			for (const p of pw.pending.values()) p.reject(err);
			pw.pending.clear();
			pw.busy = false;
		});

		w.on("exit", (code) => {
			log.warn(`TTS worker ${index} exited with code ${code}`);
			pool = pool.filter((p) => p !== pw);
		});
	});
}

function drainQueue(): void {
	while (queue.length > 0) {
		const free = pool.find((pw) => !pw.busy);
		if (!free) break;
		const job = queue.shift()!;
		free.busy = true;
		free.pending.set(job.id, { resolve: job.resolve, reject: job.reject });
		free.worker.postMessage({ id: job.id, text: job.text, words: job.words });
	}
}

function ensurePool(): Promise<void> {
	if (poolReady) return poolReady;

	poolReady = (async () => {
		log.info(`Spawning ${POOL_SIZE} TTS workers...`);
		const workers = await Promise.all(
			Array.from({ length: POOL_SIZE }, (_, i) => spawnWorker(i)),
		);
		pool = workers;
		log.info(`TTS worker pool ready (${pool.length} workers)`);
	})();

	return poolReady;
}

export async function generateTTS(text: string, words?: string[]): Promise<{ audio: Buffer; durationMs: number; wordDelays: number[] | null }> {
	await ensurePool();

	const id = nextId++;
	const splitWords = words ?? text.split(/\s+/);
	return new Promise((resolve, reject) => {
		const wrappedResolve = (v: TtsResult) => {
			log.info(`TTS generated: ${text.length} chars → ${v.wav.length} bytes, ${Math.round(v.durationMs)}ms, wordDelays=${v.wordDelays ? "yes" : "no"}`);
			resolve({ audio: v.wav, durationMs: v.durationMs, wordDelays: v.wordDelays });
		};
		queue.push({ id, text, words: splitWords, resolve: wrappedResolve, reject });
		drainQueue();
	});
}
