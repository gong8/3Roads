import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";

const MODEL_DIR: string = workerData.modelDir;

async function init() {
	const sherpa = await import("sherpa-onnx-node");
	const { OfflineTts } = (sherpa as any).default ?? sherpa;

	const tts = new OfflineTts({
		model: {
			kokoro: {
				model: resolve(MODEL_DIR, "model.onnx"),
				voices: resolve(MODEL_DIR, "voices.bin"),
				tokens: resolve(MODEL_DIR, "tokens.txt"),
				dataDir: resolve(MODEL_DIR, "espeak-ng-data"),
			},
			debug: false,
			numThreads: 8,
			provider: "cpu",
		},
		maxNumSentences: 1,
	});

	parentPort!.postMessage({ type: "ready" });

	parentPort!.on("message", (msg: { id: number; text: string }) => {
		const audio = tts.generate({ text: msg.text, sid: 0, speed: 1.0 });

		const numSamples = audio.samples.length;
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
		buf.writeUInt32LE(audio.sampleRate, 24);
		buf.writeUInt32LE(audio.sampleRate * bytesPerSample, 28);
		buf.writeUInt16LE(bytesPerSample, 32);
		buf.writeUInt16LE(16, 34);
		buf.write("data", 36);
		buf.writeUInt32LE(dataSize, 40);

		for (let i = 0; i < numSamples; i++) {
			const s = Math.max(-1, Math.min(1, audio.samples[i]));
			buf.writeInt16LE(Math.round(s * 32767), headerSize + i * bytesPerSample);
		}

		const durationMs = (numSamples / audio.sampleRate) * 1000;
		parentPort!.postMessage({ type: "result", id: msg.id, wav: buf, durationMs });
	});
}

init().catch((err) => {
	parentPort!.postMessage({ type: "error", message: err.message });
	process.exit(1);
});
