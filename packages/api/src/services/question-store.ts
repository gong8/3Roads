import { getDb } from "@3roads/shared";

// Saving questions into a set. Shared by the HTTP routes and the generation
// tools, which call it in-process with the set they were started for.

export interface TossupInput {
	question: string;
	answer: string;
	powerMarkIndex?: number;
	imageUrl?: string;
	category: string;
	subcategory: string;
	difficulty: string;
}

export interface BonusInput {
	leadin: string;
	part1Text: string;
	part1Answer: string;
	part2Text: string;
	part2Answer: string;
	part3Text: string;
	part3Answer: string;
	category: string;
	subcategory: string;
	difficulty: string;
}

export class InvalidQuestions extends Error {}

/**
 * Move a date qualifier out of the required part: "{Chilean coup of 1973}" becomes
 * "{Chilean coup} of 1973", since players needn't say the year.
 */
export function tidyAnswerBraces(answer: string): string {
	return answer.replace(/\{([^{}]*?)\s+((?:of|in)\s+\d{3,4}|\(\d{3,4}\)|\d{3,4})\}/g, "{$1} $2");
}

const LEAK_STOPWORDS = new Set(["the", "and", "of", "for", "with", "from", "this", "that"]);

/**
 * The answer words a question must not contain: the braced part's words if there is one,
 * otherwise the answer's longest word ("Mauchly" in "John Mauchly"), since other words like
 * first names can fairly appear in clues.
 */
function giveawayWords(answer: string): string[] {
	const words = (text: string) =>
		text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !LEAK_STOPWORDS.has(w));
	const required = [...answer.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(" ");
	if (required) return words(required);
	const all = words(answer.replace(/\s*\[[^\]]*\]/g, ""));
	return all.length > 0 ? [all.reduce((a, b) => (b.length > a.length ? b : a))] : [];
}

/** Descriptions of questions whose text names their own answer, e.g. "Eckert-Mauchly" for Mauchly. */
export function answerLeaks(questions: { text: string; answer: string }[]): string[] {
	const leaks: string[] = [];
	questions.forEach(({ text, answer }, i) => {
		const textWords = new Set(text.toLowerCase().split(/[^a-z0-9]+/));
		const named = giveawayWords(answer).filter((w) => textWords.has(w));
		if (named.length > 0) leaks.push(`#${i + 1} (answer "${answer}") contains "${named.join('", "')}"`);
	});
	return leaks;
}

export async function saveTossups(setId: string, tossups: TossupInput[]) {
	if (!Array.isArray(tossups) || tossups.length === 0) {
		throw new InvalidQuestions("tossups array is required and must not be empty");
	}
	for (const t of tossups) {
		if (!t.question || !t.answer || !t.category || !t.subcategory || !t.difficulty) {
			throw new InvalidQuestions("Each tossup requires question, answer, category, subcategory, and difficulty");
		}
	}
	return getDb().$transaction(async (tx) => {
		await tx.tossup.createMany({
			data: tossups.map((t) => ({
				setId,
				question: t.question,
				answer: tidyAnswerBraces(t.answer),
				powerMarkIndex: t.powerMarkIndex ?? null,
				imageUrl: t.imageUrl ?? null,
				category: t.category,
				subcategory: t.subcategory,
				difficulty: t.difficulty,
			})),
		});
		return tx.tossup.findMany({ where: { setId }, orderBy: { createdAt: "asc" } });
	});
}

export async function saveBonuses(setId: string, bonuses: BonusInput[]) {
	if (!Array.isArray(bonuses) || bonuses.length === 0) {
		throw new InvalidQuestions("bonuses array is required and must not be empty");
	}
	for (const b of bonuses) {
		if (
			!b.leadin ||
			!b.part1Text || !b.part1Answer ||
			!b.part2Text || !b.part2Answer ||
			!b.part3Text || !b.part3Answer ||
			!b.category || !b.subcategory || !b.difficulty
		) {
			throw new InvalidQuestions(
				"Each bonus requires leadin, all 3 parts (text + answer), category, subcategory, and difficulty",
			);
		}
	}
	return getDb().$transaction(async (tx) => {
		for (const b of bonuses) {
			const bonus = await tx.bonus.create({
				data: { setId, leadin: b.leadin, category: b.category, subcategory: b.subcategory, difficulty: b.difficulty },
			});
			await tx.bonusPart.createMany({
				data: [
					{ bonusId: bonus.id, partNum: 1, text: b.part1Text, answer: tidyAnswerBraces(b.part1Answer), value: 10 },
					{ bonusId: bonus.id, partNum: 2, text: b.part2Text, answer: tidyAnswerBraces(b.part2Answer), value: 10 },
					{ bonusId: bonus.id, partNum: 3, text: b.part3Text, answer: tidyAnswerBraces(b.part3Answer), value: 10 },
				],
			});
		}
		return tx.bonus.findMany({
			where: { setId },
			orderBy: { createdAt: "asc" },
			include: { parts: { orderBy: { partNum: "asc" } } },
		});
	});
}
