import { createLogger, getDb } from "@3roads/shared";
import { runCliChat, runCliChatSimple } from "./cli-chat.js";

const log = createLogger("api:orchestrator");

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT CONSTRAINTS:",
	"- Use ONLY MCP tools prefixed with mcp__3roads__ to save questions. Never attempt to use filesystem, code editing, web browsing, or any non-MCP tools.",
	"- Always include category, subcategory, and difficulty for each question.",
	"- NEVER include the answer word, any variant of it, or anything that sounds like it ANYWHERE in the question text. Replace it with a placeholder like 'this country', 'this author', 'this element', 'this work', 'this region', etc. as appropriate. The answer must not be nameable from any word in the question itself.",
	"- NEVER write clues that transparently give away the answer through etymology, word games, or trivial restatement.",
	"- Every tossup must be strictly pyramidal: hardest clues first, power mark at 1/3-1/2 through, giveaway last.",
].join("\n");

function buildTossupSystemPrompt(setId: string, difficulty: string, theme: string): string {
	return `You are an expert quiz bowl question writer producing competition-quality academic questions.

Set ID: ${setId}
Target difficulty: ${difficulty}
Theme: ${theme}

## DIFFICULTY CALIBRATION
Calibrate clue difficulty and answer selection to the "${difficulty}" level:
- Middle School: common curriculum topics, straightforward clues, well-known answers
- Easy High School: introductory-level academic content, accessible to newer players
- Regular High School: standard varsity tournament level (e.g., NAQT IS-A)
- Hard High School: championship-level high school (e.g., PACE NSC, HSNCT)
- Easy College: novice collegiate level (e.g., ACF Fall)
- Regular College: standard collegiate level (e.g., ACF Regionals)
- Hard College: difficult collegiate level (e.g., ACF Nationals)
- Open: expert-level open tournaments (e.g., Chicago Open, EFT)

## TOSSUP FORMAT (Pyramidal Structure)
Each tossup MUST follow strict pyramidal structure:
- **First 1-3 sentences:** Obscure, specific facts that only deep experts would know.
- **Middle sentences:** Moderately difficult facts that knowledgeable players would recognize.
- **Power mark (*) placement:** Insert after the transition from hard to moderate clues, roughly 1/3 to 1/2 through the question.
- **Final sentence (giveaway):** A well-known identifying fact, preceded by "For 10 points," or "FTP,"
- **End with:** "ANSWER: [answer]"

The giveaway clue must still require SOME knowledge — it should uniquely identify the answer but not be a direct restatement.

## WORKFLOW
1. Write ALL tossups, then call mcp__3roads__save_tossups_batch ONCE with setId "${setId}" and the full array.
2. For the difficulty field in each question, use "${difficulty}".
3. Do NOT call individual save_tossup tools — always use the batch version.
${SYSTEM_PROMPT_SUFFIX}`;
}

function buildBonusSystemPrompt(setId: string, difficulty: string, theme: string): string {
	return `You are an expert quiz bowl question writer producing competition-quality academic questions.

Set ID: ${setId}
Target difficulty: ${difficulty}
Theme: ${theme}

## DIFFICULTY CALIBRATION
Calibrate clue difficulty and answer selection to the "${difficulty}" level:
- Middle School: common curriculum topics, straightforward clues, well-known answers
- Easy High School: introductory-level academic content, accessible to newer players
- Regular High School: standard varsity tournament level (e.g., NAQT IS-A)
- Hard High School: championship-level high school (e.g., PACE NSC, HSNCT)
- Easy College: novice collegiate level (e.g., ACF Fall)
- Regular College: standard collegiate level (e.g., ACF Regionals)
- Hard College: difficult collegiate level (e.g., ACF Nationals)
- Open: expert-level open tournaments (e.g., Chicago Open, EFT)

## BONUS FORMAT
Each bonus has:
- **Leadin:** A plain declarative statement naming the subject of the bonus — NOT a clue, NOT a question, NOT a hint. It tells the players what the bonus is about. Examples: "This bonus is about the French Revolution.", "Answer these questions about mitosis.", "For 10 points each, name these works by Shakespeare." Never write the leadin as a riddle or teaser like "This country is renowned for its linguistic diversity" — instead write "This bonus is about Switzerland."
- **Part 1 [10]:** Easiest — most players at this difficulty should get it
- **Part 2 [10]:** Medium — requires solid knowledge
- **Part 3 [10]:** Hardest — challenges even strong players
- Each part must have a DIFFERENT answer from the other parts and from all other questions in the set

## WORKFLOW
1. Write ALL bonuses, then call mcp__3roads__save_bonuses_batch ONCE with setId "${setId}" and the full array.
2. For the difficulty field in each question, use "${difficulty}".
3. Do NOT call individual save_bonus tools — always use the batch version.
${SYSTEM_PROMPT_SUFFIX}`;
}

export async function runGeneration(params: {
	setId: string;
	theme: string;
	difficulty: string;
	tossupCount: number;
	bonusCount: number;
	model?: string;
}): Promise<void> {
	const { setId, theme, difficulty, tossupCount, bonusCount, model } = params;
	const db = getDb();

	try {
		await db.questionSet.update({
			where: { id: setId },
			data: { status: "generating" },
		});

		// Phase 1: Answer Planning
		log.info(`[${setId}] Phase 1: generating answer plan (${tossupCount} tossups, ${bonusCount} bonuses)`);

		const planPrompt = `Generate a JSON object with two arrays:
- "tossup_answers": ${tossupCount} unique answer strings for tossups about "${theme}" at ${difficulty} difficulty
- "bonus_answers": ${bonusCount} unique answer strings for bonuses about "${theme}" at ${difficulty} difficulty

Each answer should be a specific, notable topic suitable for a quiz bowl question at the ${difficulty} level.
All answers must be distinct across both arrays — no duplicates whatsoever.
Output ONLY the JSON object, no other text, no markdown fences.`;

		const planResult = await runCliChatSimple({
			prompt: planPrompt,
			systemPrompt: "You are a quiz bowl expert. Output only valid JSON.",
			model: "haiku",
		});

		// Extract JSON from the result (handle possible markdown fences)
		const jsonMatch = planResult.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error("Answer planning failed: no JSON found in response");
		}

		const plan = JSON.parse(jsonMatch[0]) as {
			tossup_answers: string[];
			bonus_answers: string[];
		};

		if (!plan.tossup_answers?.length && tossupCount > 0) {
			throw new Error("Answer planning returned no tossup answers");
		}
		if (!plan.bonus_answers?.length && bonusCount > 0) {
			throw new Error("Answer planning returned no bonus answers");
		}

		log.info(`[${setId}] Phase 1 complete: ${plan.tossup_answers?.length ?? 0} tossup answers, ${plan.bonus_answers?.length ?? 0} bonus answers`);

		// Phase 2: Parallel Question Writing
		log.info(`[${setId}] Phase 2: writing questions in parallel`);

		const tasks: Promise<{ ok: boolean; error?: string }>[] = [];

		if (tossupCount > 0) {
			const answerList = plan.tossup_answers.slice(0, tossupCount).join("\n- ");
			const tossupPrompt = `Write ${tossupCount} tossups for these specific answers:\n- ${answerList}\n\nEach tossup must be about its assigned answer. CRITICAL: the answer word and any variant or near-homophone of it must NEVER appear anywhere in the question text — refer to the subject only as 'this person', 'this country', 'this work', 'this element', etc. Save all via mcp__3roads__save_tossups_batch with setId "${setId}".`;

			tasks.push(
				runCliChat({
					prompt: tossupPrompt,
					systemPrompt: buildTossupSystemPrompt(setId, difficulty, theme),
					model: model || "haiku",
				}),
			);
		}

		if (bonusCount > 0) {
			const answerList = plan.bonus_answers.slice(0, bonusCount).join("\n- ");
			const bonusPrompt = `Write ${bonusCount} bonuses. Each bonus's theme should relate to this answer:\n- ${answerList}\n\nEach bonus has 3 parts with different answers. The leadin must be a plain declarative statement telling players what the bonus is about (e.g. "This bonus is about Switzerland." or "Answer these questions about the water cycle.") — never a clue or teaser. Save all via mcp__3roads__save_bonuses_batch with setId "${setId}".`;

			tasks.push(
				runCliChat({
					prompt: bonusPrompt,
					systemPrompt: buildBonusSystemPrompt(setId, difficulty, theme),
					model: model || "haiku",
				}),
			);
		}

		const results = await Promise.allSettled(tasks);

		const errors: string[] = [];
		for (const r of results) {
			if (r.status === "rejected") {
				errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
			} else if (!r.value.ok) {
				errors.push(r.value.error || "Unknown CLI error");
			}
		}

		if (errors.length > 0) {
			log.error(`[${setId}] Phase 2 errors: ${errors.join("; ")}`);
			await db.questionSet.update({
				where: { id: setId },
				data: { status: "error" },
			});
		} else {
			log.info(`[${setId}] Generation complete`);
			await db.questionSet.update({
				where: { id: setId },
				data: { status: "complete" },
			});
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`[${setId}] Generation failed: ${msg}`);
		await db.questionSet.update({
			where: { id: setId },
			data: { status: "error" },
		});
	}

	// Clean up sets that ended up with no questions at all
	const counts = await db.questionSet.findUnique({
		where: { id: setId },
		include: { _count: { select: { tossups: true, bonuses: true } } },
	});
	if (counts && counts._count.tossups === 0 && counts._count.bonuses === 0) {
		log.warn(`[${setId}] No questions generated — deleting empty set`);
		await db.questionSet.delete({ where: { id: setId } }).catch(() => {});
	}
}
