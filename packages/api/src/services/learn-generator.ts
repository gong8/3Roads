import { createLogger, getDb } from "@3roads/shared";
import { chunk, sameAnswer, settleLimited, shuffle } from "./generate-orchestrator.js";
import { runLlmChatSimple } from "./llm-chat.js";
import { tidyAnswerBraces } from "./question-store.js";

// Learn packets: hundreds of short "prompt -> answer" cards (painting -> artist, battle -> war)
// for drilling a topic. Generation runs in two phases: choose the answers that cover the topic,
// then write each answer's cards, a few answers per LLM call in parallel.

const log = createLogger("api:learn");

export const MAX_ANSWERS = 40;
export const MAX_CARDS_PER_ANSWER = 30;
/** Answers whose cards one LLM call writes. */
const ANSWERS_PER_CALL = 3;
const MAX_PARALLEL_CALLS = 6;

export interface LearnGenerationParams {
	packId: string;
	topic: string;
	promptKind: string;
	answerKind: string;
	answerCount: number;
	cardsPerAnswer: number;
	model?: string;
	userId: string;
}

const SYSTEM_PROMPT = "You are a quiz bowl coach building flashcard drills. You only state facts you are sure of. Output only valid JSON.";

const ANSWER_FORMAT = `Answer lines use quiz bowl brace format: wrap the part a player MUST say in {curly braces}; the rest is optional. Brace the name people actually use: "Vincent van {Gogh}", "Claude {Monet}", "{Napoleonic Wars}", "{Thirty Years' War}", "{Rembrandt} van Rijn". Add common alternatives in square brackets, braced too: "{Hundred Years' War} [accept {Edwardian War}]".`;

function parseJson<T>(raw: string): T {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) throw new Error("no JSON in response");
	return JSON.parse(match[0]) as T;
}

/** The answers that cover the topic, most important first. */
async function planAnswers(params: LearnGenerationParams, onCost: (usd: number) => void): Promise<string[]> {
	const { topic, promptKind, answerKind, answerCount, model, userId } = params;
	const prompt = `A student is drilling "${topic}": they are shown a ${promptKind} and must name its ${answerKind}.
List the ${answerCount + 5} ${answerKind} answers that matter most for quiz bowl in this topic, most important first: the ones with many well-known ${promptKind} examples that come up in questions. Each must have at least several notable ${promptKind} examples.
${ANSWER_FORMAT}
Output ONLY {"answers": ["...", ...]}.`;
	const raw = await runLlmChatSimple({ prompt, systemPrompt: SYSTEM_PROMPT, model, userId, onCost });
	const { answers } = parseJson<{ answers?: unknown[] }>(raw);
	const picked: string[] = [];
	for (const a of answers ?? []) {
		if (picked.length >= answerCount) break;
		if (typeof a !== "string" || !a.trim()) continue;
		if (picked.some((p) => sameAnswer(p, a))) continue;
		picked.push(tidyAnswerBraces(a.trim()));
	}
	if (picked.length === 0) throw new Error("planning returned no answers");
	return picked;
}

interface CardInput {
	prompt?: unknown;
	answer?: unknown;
	detail?: unknown;
}

/** Write and save the cards for a few answers. */
async function writeCards(
	params: LearnGenerationParams,
	answers: string[],
	onCost: (usd: number) => void,
): Promise<number> {
	const { packId, topic, promptKind, answerKind, cardsPerAnswer, model, userId } = params;
	const prompt = `Topic: "${topic}". Each flashcard shows a ${promptKind}; the student names its ${answerKind}.
For EACH of these ${answerKind} answers, write up to ${cardsPerAnswer} cards, one per distinct notable ${promptKind}:
${answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Rules:
- "prompt" is just the ${promptKind}'s usual name as quiz bowl would say it (e.g. "The Starry Night", "Battle of Austerlitz"). It must NOT contain or hint at the ${answerKind}'s name.
- "answer" is the answer line exactly as listed above.
- "detail" is a few words of context shown after answering (a year, a place, one memorable fact), or "".
- Order each answer's cards from most to least famous; include the important ones quiz bowl actually asks about. Fewer cards is fine when an answer has fewer real examples. Never invent a ${promptKind}.
- No ${promptKind} may appear twice.
Output ONLY {"cards": [{"prompt": "...", "answer": "...", "detail": "..."}, ...]}.`;
	const raw = await runLlmChatSimple({ prompt, systemPrompt: SYSTEM_PROMPT, model, userId, onCost });
	const { cards } = parseJson<{ cards?: CardInput[] }>(raw);

	const rows: { packId: string; prompt: string; answer: string; detail: string | null }[] = [];
	for (const c of cards ?? []) {
		if (typeof c.prompt !== "string" || typeof c.answer !== "string") continue;
		const cardPrompt = c.prompt.trim();
		// Keep the planned answer line so every card of one answer is judged the same way
		const answer = answers.find((a) => sameAnswer(a, c.answer as string)) ?? tidyAnswerBraces(c.answer.trim());
		if (!cardPrompt || !answer) continue;
		rows.push({ packId, prompt: cardPrompt, answer, detail: typeof c.detail === "string" && c.detail.trim() ? c.detail.trim() : null });
	}
	if (rows.length === 0) throw new Error(`no cards written for ${answers.join(", ")}`);
	await getDb().learnCard.createMany({ data: rows });
	return rows.length;
}

/** Drop cards whose prompt repeats an earlier card's, which parallel calls can produce. */
async function removeDuplicateCards(packId: string): Promise<void> {
	const db = getDb();
	const cards = await db.learnCard.findMany({ where: { packId }, orderBy: { createdAt: "asc" } });
	const seen = new Set<string>();
	const duplicates: string[] = [];
	for (const card of cards) {
		const key = card.prompt.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (seen.has(key)) duplicates.push(card.id);
		else seen.add(key);
	}
	if (duplicates.length > 0) await db.learnCard.deleteMany({ where: { id: { in: duplicates } } });
}

export async function runLearnGeneration(params: LearnGenerationParams): Promise<void> {
	const { packId } = params;
	const db = getDb();
	let cost: number | null = null;
	const onCost = (usd: number) => {
		cost = (cost ?? 0) + usd;
	};

	try {
		const answers = await planAnswers(params, onCost);
		log.info(`[${packId}] planned ${answers.length} answers: ${answers.join("; ")}`);
		// Shuffled so a slow or failed call doesn't always cost the same end of the list
		const jobs = chunk(shuffle(answers), ANSWERS_PER_CALL).map((group) => () => writeCards(params, group, onCost));
		const results = await settleLimited(jobs, MAX_PARALLEL_CALLS);
		await removeDuplicateCards(packId);
		const errors = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []));
		const count = await db.learnCard.count({ where: { packId } });
		if (count === 0) throw new Error(errors[0] ?? "no cards written");
		if (errors.length > 0) log.warn(`[${packId}] ${errors.length} batch(es) failed: ${errors.join("; ")}`);
		await db.learnPack.update({
			where: { id: packId },
			data: { status: "complete", cost, error: errors.length > 0 ? `${errors.length} of ${jobs.length} batches failed` : null },
		});
		log.info(`[${packId}] complete — ${count} cards${cost != null ? `, $${(cost as number).toFixed(4)}` : ""}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`[${packId}] generation failed: ${msg}`);
		await db.learnPack.update({ where: { id: packId }, data: { status: "error", error: msg, cost } }).catch(() => {});
	}
}
