import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const MODEL_DIR: string = workerData.modelDir;

const SAMPLE_RATE = 24000;
const STYLE_DIM = 256;
const MAX_STYLE_ROWS = 510;
const DURATION_DIVISOR = 80; // frames → seconds: duration / 80

// -- Load tokens.txt into a char→ID map --

function loadVocab(path: string): Map<string, number> {
	const vocab = new Map<string, number>();
	const lines = readFileSync(path, "utf-8").split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		// Format: "char id" — but char can be a space, so split from the right
		const lastSpace = line.lastIndexOf(" ");
		if (lastSpace < 0) continue;
		const char = line.slice(0, lastSpace);
		const id = parseInt(line.slice(lastSpace + 1), 10);
		if (!isNaN(id)) vocab.set(char, id);
	}
	return vocab;
}

// -- Load voice file (shape [510, 256], raw float32) --

function loadVoice(path: string): Float32Array {
	const buf = readFileSync(path);
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function getStyleVector(voiceData: Float32Array, numTokens: number): Float32Array {
	// Index by number of phoneme tokens (excluding BOS/EOS pads)
	const idx = Math.min(Math.max(numTokens, 0), MAX_STYLE_ROWS - 1);
	return voiceData.slice(idx * STYLE_DIM, (idx + 1) * STYLE_DIM);
}

// -- Tokenize phoneme string using vocab --

function tokenize(phonemes: string, vocab: Map<string, number>): number[] {
	const ids: number[] = [0]; // BOS pad
	for (const char of phonemes) {
		const id = vocab.get(char);
		if (id !== undefined) ids.push(id);
		// Skip unknown chars (same as model's normalizer)
	}
	ids.push(0); // EOS pad
	return ids;
}

// -- Encode PCM samples to WAV buffer --

function encodeWav(samples: Float32Array): Buffer {
	const numSamples = samples.length;
	const bytesPerSample = 2;
	const dataSize = numSamples * bytesPerSample;
	const headerSize = 44;
	const buf = Buffer.alloc(headerSize + dataSize);

	buf.write("RIFF", 0);
	buf.writeUInt32LE(headerSize + dataSize - 8, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(SAMPLE_RATE, 24);
	buf.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28);
	buf.writeUInt16LE(bytesPerSample, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(dataSize, 40);

	for (let i = 0; i < numSamples; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		buf.writeInt16LE(Math.round(s * 32767), headerSize + i * bytesPerSample);
	}

	return buf;
}

// -- Map pred_dur to per-word delays --
// Distributes duration proportionally then scales to actual audio duration in ms.
// This avoids needing the exact frame→second divisor (which varies by model variant).

function mapDurationsToWords(
	predDur: Float32Array | number[],
	phonemeCharCounts: number[],
	audioDurationMs: number,
): number[] {
	const numWords = phonemeCharCounts.length;
	const wordFrames = new Array<number>(numWords).fill(0);

	let tokenIdx = 0;
	const bosDur = predDur[tokenIdx++]; // BOS pad → first word
	wordFrames[0] += bosDur;

	for (let w = 0; w < numWords; w++) {
		// Sum phoneme durations for this word
		const count = phonemeCharCounts[w];
		for (let j = 0; j < count; j++) {
			if (tokenIdx < predDur.length) {
				wordFrames[w] += predDur[tokenIdx++];
			}
		}

		if (w < numWords - 1) {
			// Space token — split 50/50 between adjacent words
			if (tokenIdx < predDur.length) {
				const spaceDur = predDur[tokenIdx++];
				wordFrames[w] += spaceDur / 2;
				wordFrames[w + 1] += spaceDur / 2;
			}
		}
	}

	// EOS pad → last word
	if (tokenIdx < predDur.length) {
		wordFrames[numWords - 1] += predDur[tokenIdx];
	}

	// Normalize: scale proportionally so word delays sum to actual audio duration
	const totalFrames = wordFrames.reduce((sum, f) => sum + f, 0);
	if (totalFrames <= 0) return wordFrames.map(() => audioDurationMs / numWords);
	return wordFrames.map((f) => (f / totalFrames) * audioDurationMs);
}

// -- Main init --

async function init() {
	const ort = await import("onnxruntime-node");
	const { phonemize } = await import("phonemizer");

	const vocab = loadVocab(resolve(MODEL_DIR, "tokens.txt"));
	const voiceData = loadVoice(resolve(MODEL_DIR, "af_heart.bin"));

	const session = await ort.InferenceSession.create(
		resolve(MODEL_DIR, "model_quantized.onnx"),
		{
			executionProviders: ["cpu"],
			interOpNumThreads: 1,
			intraOpNumThreads: 1,
		},
	);

	parentPort!.postMessage({ type: "ready" });

	parentPort!.on("message", async (msg: { id: number; text: string; words: string[] }) => {
		try {
			const { id, text, words } = msg;

			// Step 1: Phonemize each word separately to track per-word phoneme counts
			let phonemeCharCounts: number[] | null = null;
			let joinedPhonemes: string;

			try {
				const wordPhonemes: string[] = [];
				for (const word of words) {
					const result = await phonemize(word, "en-us");
					const ph = (Array.isArray(result) ? result[0] : result) || "";
					wordPhonemes.push(ph.trim());
				}
				phonemeCharCounts = wordPhonemes.map((p) => [...p].length);
				joinedPhonemes = wordPhonemes.join(" ");
			} catch {
				// Fallback: phonemize entire text as one unit (no word mapping)
				const result = await phonemize(text, "en-us");
				joinedPhonemes = (Array.isArray(result) ? result[0] : result) || text;
				phonemeCharCounts = null;
			}

			// Step 2: Tokenize
			const tokenIds = tokenize(joinedPhonemes, vocab);

			// Step 3: Build input tensors
			const numPhonemeTokens = tokenIds.length - 2; // exclude BOS/EOS
			const style = getStyleVector(voiceData, numPhonemeTokens);

			const inputIds = new ort.Tensor(
				"int64",
				BigInt64Array.from(tokenIds.map(BigInt)),
				[1, tokenIds.length],
			);
			const styleTensor = new ort.Tensor("float32", style, [1, STYLE_DIM]);
			const speedTensor = new ort.Tensor("float32", new Float32Array([1.0]), [1]);

			// Step 4: Run inference
			const results = await session.run({
				input_ids: inputIds,
				style: styleTensor,
				speed: speedTensor,
			});

			// Extract outputs — names may vary, try common names then fall back to positional
			const outputNames = Object.keys(results);
			const audioOutput = results["waveform"] ?? results["audio"] ?? results[outputNames[0]];
			const durOutput = results["pred_dur"] ?? results["durations"] ?? results[outputNames[1]];

			const audioSamples = audioOutput.data as Float32Array;
			const predDur = durOutput?.data as Float32Array | undefined;

			// Step 5: Encode WAV and compute duration
			const wav = encodeWav(audioSamples);
			const durationMs = (audioSamples.length / SAMPLE_RATE) * 1000;

			// Step 6: Compute word delays (normalized to actual audio duration)
			let wordDelays: number[] | null = null;
			if (predDur && phonemeCharCounts) {
				try {
					wordDelays = mapDurationsToWords(predDur, phonemeCharCounts, durationMs);
					// Sanity check: word count must match
					if (wordDelays.length !== words.length) {
						wordDelays = null;
					}
				} catch {
					wordDelays = null;
				}
			}

			parentPort!.postMessage({ type: "result", id, wav, durationMs, wordDelays });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			parentPort!.postMessage({ type: "error", id: msg.id, message });
		}
	});
}

init().catch((err) => {
	parentPort!.postMessage({ type: "error", message: err.message });
	process.exit(1);
});
