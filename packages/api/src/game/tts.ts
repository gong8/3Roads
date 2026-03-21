import { createLogger } from "@3roads/shared";

const log = createLogger("api:game:tts");

const FISH_SPEECH_URL = process.env.FISH_SPEECH_URL || "http://localhost:8080";

// In-memory audio cache with auto-cleanup
const audioCache = new Map<string, { buffer: Buffer; expires: number }>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

/**
 * Calculate WAV duration from buffer.
 * Standard WAV header is 44 bytes. We read sample rate, channels, and bits per sample from the header.
 */
function wavDurationMs(buf: Buffer): number {
	if (buf.length < 44) return 0;
	const sampleRate = buf.readUInt32LE(24);
	const channels = buf.readUInt16LE(22);
	const bitsPerSample = buf.readUInt16LE(34);
	const bytesPerSample = bitsPerSample / 8;
	const dataSize = buf.length - 44;
	if (sampleRate === 0 || channels === 0 || bytesPerSample === 0) return 0;
	return (dataSize / (sampleRate * channels * bytesPerSample)) * 1000;
}

// Track whether Fish Speech is reachable
let fishReady = false;
let fishCheckPromise: Promise<void> | null = null;

async function waitForFishSpeech(): Promise<void> {
	if (fishReady) return;
	if (fishCheckPromise) return fishCheckPromise;

	fishCheckPromise = (async () => {
		log.info("Waiting for Fish Speech server...");
		for (let i = 0; i < 60; i++) {
			try {
				const res = await fetch(`${FISH_SPEECH_URL}/v1/health`, { signal: AbortSignal.timeout(2000) });
				if (res.ok) {
					fishReady = true;
					log.info("Fish Speech server is ready");
					return;
				}
			} catch {
				// not ready yet
			}
			await new Promise((r) => setTimeout(r, 3000));
		}
		throw new Error("Fish Speech server did not become ready within 3 minutes");
	})();

	try {
		await fishCheckPromise;
	} finally {
		fishCheckPromise = null;
	}
}

export async function generateTTS(text: string): Promise<{ audio: Buffer; durationMs: number }> {
	await waitForFishSpeech();

	const res = await fetch(`${FISH_SPEECH_URL}/v1/tts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text, format: "wav" }),
	});

	if (!res.ok) {
		throw new Error(`Fish Speech TTS failed: ${res.status} ${res.statusText}`);
	}

	const arrayBuffer = await res.arrayBuffer();
	const audio = Buffer.from(arrayBuffer);
	const durationMs = wavDurationMs(audio);

	log.info(`TTS generated: ${text.length} chars → ${audio.length} bytes, ${Math.round(durationMs)}ms`);

	return { audio, durationMs };
}
