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
				answer: t.answer,
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
					{ bonusId: bonus.id, partNum: 1, text: b.part1Text, answer: b.part1Answer, value: 10 },
					{ bonusId: bonus.id, partNum: 2, text: b.part2Text, answer: b.part2Answer, value: 10 },
					{ bonusId: bonus.id, partNum: 3, text: b.part3Text, answer: b.part3Answer, value: 10 },
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
