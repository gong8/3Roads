import { createLogger } from "@3roads/shared";
import type { WebSocket } from "ws";
import { DEFAULT_MODEL, runLlmChatSimple } from "../services/llm-chat.js";
import type { GameRoom } from "./types.js";

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
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
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
 * goes to the LLM.
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
	/** The answering player's ChatGPT token; without one, ambiguous answers are judged incorrect. */
	token?: string,
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
	if (!token) {
		log.info(`judge [local] — submitted="${submittedAnswer}" unsure and the player is not signed in, verdict=incorrect`);
		return { correct: false };
	}
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
		const result = await fetchJudge(token, systemPrompt, userPrompt);
		const correct = result.trim().toLowerCase().includes("correct") &&
			!result.trim().toLowerCase().startsWith("incorrect");
		log.info(`judge [llm] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${correct ? "correct" : "incorrect"}`);
		return { correct };
	} catch (err) {
		log.error(`judge [llm] — error: ${err instanceof Error ? err.message : err}, treating as incorrect`);
		return { correct: false };
	}
}

// -- LLM backend --

const JUDGE_MODEL = process.env.OPENAI_JUDGE_MODEL || DEFAULT_MODEL;

/** Connected players' ChatGPT access tokens, read from their cookies at WebSocket upgrade. Memory only. */
export const socketTokens = new WeakMap<WebSocket, { token: string; expiresAt: number }>();

/**
 * The answering player's own token, if they are signed in. Never another player's:
 * one player's answers must not spend someone else's ChatGPT plan.
 * ponytail: captured at connect and not refreshed, so after an hour that player falls
 * back to local judging; refresh over the socket if long games need the LLM.
 */
export function playerToken(room: GameRoom, playerId: string): string | undefined {
	const ws = room.players.get(playerId)?.ws;
	const t = ws && socketTokens.get(ws);
	return t && t.expiresAt > Date.now() + 30_000 ? t.token : undefined;
}

function fetchJudge(token: string, systemPrompt: string, userPrompt: string): Promise<string> {
	return runLlmChatSimple({
		token,
		model: JUDGE_MODEL,
		systemPrompt,
		prompt: userPrompt,
		signal: AbortSignal.timeout(15_000),
	});
}
