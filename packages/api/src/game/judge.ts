import { spawn } from "node:child_process";
import { createLogger } from "@3roads/shared";

const log = createLogger("api:game:judge");

// -- Local answer matching (fast path) --

/**
 * Parse quiz bowl canonical answer to extract all acceptable forms.
 * e.g. "DNA [accept deoxyribonucleic acid]" → ["DNA", "deoxyribonucleic acid"]
 * e.g. "France [or French Republic]" → ["France", "French Republic"]
 */
function parseAcceptableAnswers(canonical: string): string[] {
	const answers: string[] = [];

	// Extract main answer (everything before the first bracket or parenthesis)
	const mainMatch = canonical.match(/^([^\[\(]+)/);
	if (mainMatch) {
		const main = mainMatch[1].trim();
		if (main) answers.push(main);
	}

	// Extract bracketed alternatives: [accept X], (accept: X), [or X], (or X)
	const bracketPattern = /[\[\(](?:accept|or):?\s+([^\]\)]+)[\]\)]/gi;
	let match: RegExpExecArray | null;
	while ((match = bracketPattern.exec(canonical)) !== null) {
		const alt = match[1].trim();
		if (alt) answers.push(alt);
	}

	if (answers.length === 0) {
		answers.push(canonical.trim());
	}
	return answers;
}

/** Normalize an answer for comparison: lowercase, strip articles/punctuation, collapse whitespace. */
function normalize(answer: string): string {
	return answer
		.toLowerCase()
		.trim()
		.replace(/^(a|an|the)\s+/i, "")
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Standard Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const matrix: number[][] = [];
	for (let i = 0; i <= a.length; i++) {
		matrix[i] = [i];
	}
	for (let j = 0; j <= b.length; j++) {
		matrix[0][j] = j;
	}

	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,       // deletion
				matrix[i][j - 1] + 1,       // insertion
				matrix[i - 1][j - 1] + cost, // substitution
			);
		}
	}
	return matrix[a.length][b.length];
}

/**
 * Fast local judge. Returns "correct", "incorrect", or "unsure".
 * "unsure" means we need to fall back to the LLM.
 */
function localJudge(
	submitted: string,
	canonical: string,
	strictness: number,
): "correct" | "incorrect" | "unsure" {
	const normalizedSubmitted = normalize(submitted);
	if (!normalizedSubmitted) return "incorrect";

	const acceptableForms = parseAcceptableAnswers(canonical);

	// Strictness-adjusted similarity threshold:
	//   strictness 1 (strict)  → 0.90
	//   strictness 7 (default) → 0.72
	//   strictness 10 (lenient) → 0.63
	const similarityThreshold = 0.93 - strictness * 0.03;

	let bestSimilarity = 0;

	const GENERIC_WORDS = new Set([
		"river", "lake", "sea", "ocean", "mount", "mountain", "mountains", "strait", "bay", "gulf", "peninsula", "island", "islands",
		"battle", "war", "treaty", "king", "queen", "president", "emperor", "empire", "republic", "state", "city", "county",
		"syndrome", "effect", "law", "theory", "theorem", "equation", "formula", "constant", "principle", "rule", "model",
		"first", "second", "third", "st", "nd", "rd", "th"
	]);

	for (const form of acceptableForms) {
		const normalizedForm = normalize(form);
		if (!normalizedForm) continue;

		// 1. Exact match
		if (normalizedSubmitted === normalizedForm) return "correct";

		// 2. Keyword containment (Prefix / Suffix)
		//    "bach" matches "johann sebastian bach", "rhine" matches "rhine river"
		const formWords = normalizedForm.split(" ");
		
		if (formWords.length > 1 && !GENERIC_WORDS.has(normalizedSubmitted)) {
			// Suffix matches
			for (let n = 1; n < formWords.length; n++) {
				const tail = formWords.slice(-n).join(" ");
				if (normalizedSubmitted === tail) return "correct";
			}
			// Prefix matches
			for (let n = 1; n < formWords.length; n++) {
				const head = formWords.slice(0, n).join(" ");
				if (normalizedSubmitted === head) return "correct";
			}
		}

		// Reverse keyword containment (e.g. submitted "william shakespeare", canonical "shakespeare")
		const submittedWords = normalizedSubmitted.split(" ");
		if (submittedWords.length > 1 && formWords.length === 1 && !GENERIC_WORDS.has(normalizedForm)) {
			if (submittedWords.includes(normalizedForm)) return "correct";
		}

		// 3. Levenshtein similarity
		const dist = levenshtein(normalizedSubmitted, normalizedForm);
		const maxLen = Math.max(normalizedSubmitted.length, normalizedForm.length);
		const similarity = maxLen > 0 ? 1 - dist / maxLen : 0;
		bestSimilarity = Math.max(bestSimilarity, similarity);

		if (similarity >= similarityThreshold) return "correct";
	}

	// Fast reject: if very dissimilar from all acceptable forms, it's likely a junk answer.
	if (bestSimilarity < 0.3) return "incorrect";

	// Ambiguous — need LLM
	return "unsure";
}

// -- Public API --

export async function judgeAnswer(
	submittedAnswer: string,
	canonicalAnswer: string,
	questionText: string,
	strictness: number,
): Promise<{ correct: boolean }> {
	if (!submittedAnswer.trim()) {
		return { correct: false };
	}

	// Fast path: try local matching first
	const localVerdict = localJudge(submittedAnswer, canonicalAnswer, strictness);
	if (localVerdict !== "unsure") {
		const correct = localVerdict === "correct";
		log.info(`judge [local] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${localVerdict}`);
		return { correct };
	}

	// Slow path: fall back to LLM for ambiguous cases
	log.info(`judge [llm] — local unsure, falling back to LLM for submitted="${submittedAnswer}" canonical="${canonicalAnswer}"`);

	const systemPrompt = "You are a quiz bowl answer judge. Respond with ONLY \"correct\" or \"incorrect\".";
	const userPrompt = [
		`The canonical answer is: ${canonicalAnswer}`,
		`The player submitted: ${submittedAnswer}`,
		`The question was: ${questionText.slice(0, 500)}`,
		`Leniency: ${strictness}/10. At 1, require an exact match. At 10, accept any answer that demonstrates knowledge of the correct answer. At the default of 7, accept reasonable variations like missing articles, minor misspellings, or partial but clearly correct answers.`,
	].join("\n");

	try {
		const result = ANTHROPIC_API_KEY
			? await fetchJudge(systemPrompt, userPrompt)
			: await spawnJudge(`${systemPrompt}\n${userPrompt}\nRespond with ONLY "correct" or "incorrect".`);
		const correct = result.trim().toLowerCase().includes("correct") &&
			!result.trim().toLowerCase().startsWith("incorrect");
		log.info(`judge [llm] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${correct ? "correct" : "incorrect"}`);
		return { correct };
	} catch (err) {
		log.error(`judge [llm] — error: ${err instanceof Error ? err.message : err}, treating as incorrect`);
		return { correct: false };
	}
}

// -- LLM backends --

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_JUDGE_MODEL || "claude-3-5-haiku-20241022";

if (ANTHROPIC_API_KEY) {
	log.info(`Judge LLM backend: direct API (model=${ANTHROPIC_MODEL})`);
} else {
	log.info("Judge LLM backend: CLI spawn (no ANTHROPIC_API_KEY set)");
}

/** Fast path: direct Anthropic Messages API call (~200-500ms). */
async function fetchJudge(systemPrompt: string, userPrompt: string): Promise<string> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": ANTHROPIC_API_KEY,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "prompt-caching-2024-07-31",
		},
		body: JSON.stringify({
			model: ANTHROPIC_MODEL,
			max_tokens: 16,
			system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
			messages: [{ role: "user", content: userPrompt }],
		}),
		signal: AbortSignal.timeout(10000),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
	}

	const data = await res.json() as { content: { type: string; text: string }[] };
	return data.content?.[0]?.text ?? "";
}

/** Slow path: spawn claude CLI process (~1-2s). */
function spawnJudge(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = [
			"--print",
			"--model",
			"haiku",
			"--max-turns",
			"1",
			"--no-session-persistence",
			"--setting-sources",
			"",
			prompt,
		];

		const proc = spawn("claude", args, {
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timeout = setTimeout(() => {
			proc.kill("SIGTERM");
			reject(new Error("Judge timed out after 30s"));
		}, 30000);

		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (code !== 0 && !stdout.trim()) {
				reject(new Error(`Judge exited with code ${code}: ${stderr.slice(0, 200)}`));
			} else {
				resolve(stdout);
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		proc.stdin.end();
	});
}

