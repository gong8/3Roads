import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createLogger } from "@3roads/shared";

const log = createLogger("api:game:tts");

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(__dirname, "../../../../data/models/kokoro-en-v0_19");
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

// Worker-based TTS
let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: { wav: Buffer; durationMs: number }) => void; reject: (e: Error) => void }>();

function ensureWorker(): Promise<void> {
	if (workerReady) return workerReady;

	workerReady = new Promise((resolveReady, rejectReady) => {
		log.info("Spawning TTS worker...");
		const isTsFile = WORKER_PATH.endsWith(".ts");
		const w = new Worker(WORKER_PATH, {
			workerData: { modelDir: MODEL_DIR },
			...(isTsFile ? { execArgv: ["--import", "tsx"] } : {}),
		});

		w.on("message", (msg: any) => {
			if (msg.type === "ready") {
				log.info("TTS worker ready");
				worker = w;
				resolveReady();
				return;
			}
			if (msg.type === "result") {
				const p = pending.get(msg.id);
				if (p) {
					pending.delete(msg.id);
					p.resolve({ wav: msg.wav, durationMs: msg.durationMs });
				}
			}
		});

		w.on("error", (err) => {
			log.error(`TTS worker error: ${err.message}`);
			rejectReady(err);
			for (const p of pending.values()) p.reject(err);
			pending.clear();
		});

		w.on("exit", (code) => {
			log.warn(`TTS worker exited with code ${code}`);
			worker = null;
			workerReady = null;
		});
	});

	return workerReady;
}

export async function generateTTS(text: string): Promise<{ audio: Buffer; durationMs: number }> {
	await ensureWorker();
	if (!worker) throw new Error("TTS worker not available");

	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve: (v) => {
			log.info(`TTS generated: ${text.length} chars → ${v.wav.length} bytes, ${Math.round(v.durationMs)}ms`);
			resolve({ audio: v.wav, durationMs: v.durationMs });
		}, reject });
		worker!.postMessage({ id, text });
	});
}
