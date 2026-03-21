declare module "sherpa-onnx-node" {
	interface KokoroConfig {
		model: string;
		voices: string;
		tokens: string;
		dataDir: string;
	}

	interface ModelConfig {
		kokoro: KokoroConfig;
		debug?: boolean;
		numThreads?: number;
		provider?: string;
	}

	interface TtsConfig {
		model: ModelConfig;
		maxNumSentences?: number;
	}

	interface TtsOutput {
		samples: Float32Array;
		sampleRate: number;
	}

	class OfflineTts {
		constructor(config: TtsConfig);
		generate(opts: { text: string; sid?: number; speed?: number }): TtsOutput;
	}

	function writeWave(filename: string, opts: { samples: Float32Array; sampleRate: number }): void;
}
