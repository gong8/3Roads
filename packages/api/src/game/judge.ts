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

/**
 * Fast local judge. Returns "correct", "incorrect", or "unsure".
 * "unsure" means we need to fall back to the LLM.
 */
/**
 * Very strict local judge. Only accepts exact normalized matches
 * (case-insensitive, stripped articles/punctuation). Everything else
 * goes to Claude Haiku.
 */
function localJudge(
	submitted: string,
	canonical: string,
): "correct" | "unsure" {
	const normalizedSubmitted = normalize(submitted);
	if (!normalizedSubmitted) return "unsure";

	const acceptableForms = parseAcceptableAnswers(canonical);

	for (const form of acceptableForms) {
		const normalizedForm = normalize(form);
		if (!normalizedForm) continue;

		// Exact normalized match
		if (normalizedSubmitted === normalizedForm) return "correct";

		// Order-agnostic match for conjunctive answers ("spain and france" == "france and spain")
		const splitPattern = /\s+and\s+|\s*[,&]\s*/;
		if (splitPattern.test(normalizedForm) || splitPattern.test(normalizedSubmitted)) {
			const sortParts = (s: string) => s.split(splitPattern).map((p) => p.trim()).filter(Boolean).sort().join(" ");
			if (sortParts(normalizedSubmitted) === sortParts(normalizedForm)) return "correct";
		}

		// Surname match: submitted = last word of a multi-word answer (e.g. "atkinson" for "Rowan Atkinson")
		const formWords = normalizedForm.split(" ");
		if (formWords.length > 1 && normalizedSubmitted === formWords[formWords.length - 1]) return "correct";
	}

	// Everything else goes to LLM
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

	// Fast path: only accept exact normalized matches locally
	const localVerdict = localJudge(submittedAnswer, canonicalAnswer);
	if (localVerdict === "correct") {
		log.info(`judge [local] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=correct`);
		return { correct: true };
	}

	// Slow path: fall back to LLM for ambiguous cases
	// Strip bracketed moderator notes (e.g. "[prompt on X]") from canonical before sending to LLM
	const canonicalForLlm = canonicalAnswer.replace(/\s*\[[^\]]*\]/g, "").trim();
	log.info(`judge [llm] — local unsure, falling back to LLM for submitted="${submittedAnswer}" canonical="${canonicalForLlm}"`);

	const systemPrompt = "You are a quiz bowl answer judge. Respond with ONLY \"correct\" or \"incorrect\".";
	const userPrompt = [
		`The canonical answer is: ${canonicalForLlm}`,
		`The player submitted: ${submittedAnswer}`,
		`The question was: ${questionText.slice(0, 500)}`,
		`Leniency: ${strictness}/10. At 1, require an exact match. At 10, accept any answer that demonstrates knowledge of the correct answer. At the default of 7, accept reasonable variations like missing articles, minor misspellings, partial but clearly correct answers, adjective/demonym forms (e.g. "Italian" for "Italy"), and surnames alone for person answers (e.g. "Atkinson" is correct for "Rowan Atkinson").`,
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
const ANTHROPIC_MODEL = process.env.ANTHROPIC_JUDGE_MODEL || "claude-haiku-4-5-20251001";

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

