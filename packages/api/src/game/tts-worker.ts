import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const MODEL_DIR: string = workerData.modelDir;

const SAMPLE_RATE = 24000;
const STYLE_DIM = 256;
const MAX_STYLE_ROWS = 510;

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
		resolve(MODEL_DIR, "model.onnx"),
		{
			executionProviders: ["cpu"],
			interOpNumThreads: 1,
			intraOpNumThreads: 1,
		},
	);

	// Max phoneme tokens per chunk (model max is 512, minus 2 for BOS/EOS padding)
	const MAX_PHONEME_TOKENS = 510;

	// Phonemize a list of words, returning per-word phoneme strings
	async function phonemizeWords(words: string[]): Promise<string[]> {
		const result: string[] = [];
		for (const word of words) {
			const r = await phonemize(word, "en-us");
			const ph = (Array.isArray(r) ? r[0] : r) || "";
			result.push(ph.trim());
		}
		return result;
	}

	// Run inference on a single chunk of phonemes, returning audio samples + durations
	async function generateChunk(
		chunkPhonemes: string,
	): Promise<{ samples: Float32Array; predDur: Float32Array | null }> {
		const tokenIds = tokenize(chunkPhonemes, vocab);
		const numPhonemeTokens = tokenIds.length - 2;
		const style = getStyleVector(voiceData, numPhonemeTokens);

		const inputIds = new ort.Tensor(
			"int64",
			BigInt64Array.from(tokenIds.map(BigInt)),
			[1, tokenIds.length],
		);
		const styleTensor = new ort.Tensor("float32", style, [1, STYLE_DIM]);
		const speedTensor = new ort.Tensor("float32", new Float32Array([1.0]), [1]);

		const results = await session.run({
			input_ids: inputIds,
			style: styleTensor,
			speed: speedTensor,
		});

		const outputNames = Object.keys(results);
		const audioOutput = results["waveform"] ?? results["audio"] ?? results[outputNames[0]];
		const durOutput = results["pred_dur"] ?? results["durations"] ?? results[outputNames[1]];

		return {
			samples: audioOutput.data as Float32Array,
			predDur: durOutput?.data as Float32Array ?? null,
		};
	}

	// Check if a word ends a sentence (ends with . ! ? or similar)
	function isSentenceEnd(word: string): boolean {
		return /[.!?]['""»)]*$/.test(word);
	}

	// Estimate token count for a set of phoneme strings joined with spaces
	function estimateTokens(phonemeStrs: string[]): number {
		let count = 0;
		for (let i = 0; i < phonemeStrs.length; i++) {
			count += [...phonemeStrs[i]].length;
			if (i > 0) count++; // space token
		}
		return count;
	}

	// Split words into chunks at sentence boundaries that fit within MAX_PHONEME_TOKENS.
	// Falls back to word-level splitting only if a single sentence exceeds the limit.
	function splitIntoChunks(
		words: string[],
		wordPhonemes: string[],
	): { wordIndices: number[]; phonemes: string; charCounts: number[] }[] {
		// First, group words into sentences
		const sentences: number[][] = []; // each entry is array of word indices
		let currentSentence: number[] = [];
		for (let i = 0; i < words.length; i++) {
			currentSentence.push(i);
			if (isSentenceEnd(words[i]) || i === words.length - 1) {
				sentences.push(currentSentence);
				currentSentence = [];
			}
		}

		// Now pack sentences into chunks that fit within the token limit
		const chunks: { wordIndices: number[]; phonemes: string; charCounts: number[] }[] = [];
		let chunkWordIndices: number[] = [];
		let chunkPhonemes: string[] = [];

		function flushChunk() {
			if (chunkWordIndices.length === 0) return;
			chunks.push({
				wordIndices: [...chunkWordIndices],
				phonemes: chunkPhonemes.join(" "),
				charCounts: chunkWordIndices.map((idx) => [...wordPhonemes[idx]].length),
			});
			chunkWordIndices = [];
			chunkPhonemes = [];
		}

		for (const sentence of sentences) {
			const sentencePhonemes = sentence.map((i) => wordPhonemes[i]);
			const sentenceTokens = estimateTokens(sentencePhonemes);

			if (sentenceTokens > MAX_PHONEME_TOKENS) {
				// Single sentence too long — flush current chunk, then split sentence by words
				flushChunk();
				for (const i of sentence) {
					const ph = wordPhonemes[i];
					const addedTokens = [...ph].length + (chunkPhonemes.length > 0 ? 1 : 0);
					if (estimateTokens(chunkPhonemes) + addedTokens > MAX_PHONEME_TOKENS && chunkPhonemes.length > 0) {
						flushChunk();
					}
					chunkWordIndices.push(i);
					chunkPhonemes.push(ph);
				}
				flushChunk();
				continue;
			}

			// Check if adding this sentence would exceed the limit
			const combinedPhonemes = [...chunkPhonemes, ...sentencePhonemes];
			if (estimateTokens(combinedPhonemes) > MAX_PHONEME_TOKENS) {
				flushChunk();
			}

			chunkWordIndices.push(...sentence);
			chunkPhonemes.push(...sentencePhonemes);
		}

		flushChunk();
		return chunks;
	}

	parentPort!.postMessage({ type: "ready" });

	parentPort!.on("message", async (msg: { id: number; text: string; words: string[] }) => {
		try {
			const { id, words } = msg;

			// Step 1: Phonemize each word
			const wordPhonemes = await phonemizeWords(words);

			// Step 2: Split into chunks that fit within token limit
			const chunks = splitIntoChunks(words, wordPhonemes);

			// Step 3: Generate audio for each chunk
			const allSamples: Float32Array[] = [];
			const allWordDelays: number[] = [];
			let totalOk = true;

			for (const chunk of chunks) {
				const { samples, predDur } = await generateChunk(chunk.phonemes);
				allSamples.push(samples);

				const chunkDurationMs = (samples.length / SAMPLE_RATE) * 1000;

				if (predDur && totalOk) {
					try {
						const delays = mapDurationsToWords(predDur, chunk.charCounts, chunkDurationMs);
						allWordDelays.push(...delays);
					} catch {
						totalOk = false;
					}
				} else {
					totalOk = false;
				}
			}

			// Step 4: Concatenate audio
			const totalSamples = allSamples.reduce((n, s) => n + s.length, 0);
			const combined = new Float32Array(totalSamples);
			let offset = 0;
			for (const s of allSamples) {
				combined.set(s, offset);
				offset += s.length;
			}

			const wav = encodeWav(combined);
			const durationMs = (combined.length / SAMPLE_RATE) * 1000;
			const wordDelays = totalOk && allWordDelays.length === words.length ? allWordDelays : null;

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
