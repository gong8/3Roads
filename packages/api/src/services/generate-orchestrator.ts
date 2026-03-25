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

// -- Wikipedia picture tossup generation --

const WIKI_API = "https://en.wikipedia.org/api/rest_v1/page/summary";

interface WikiSummary {
	title: string;
	thumbnail?: { source: string };
	originalimage?: { source: string };
	description?: string;
	extract?: string;
}

async function fetchWikiImage(title: string): Promise<string | null> {
	try {
		const res = await fetch(`${WIKI_API}/${encodeURIComponent(title)}`, {
			headers: { "User-Agent": "3Roads-QuizBowl/1.0" },
		});
		if (!res.ok) return null;
		const data = await res.json() as WikiSummary;
		return data.originalimage?.source ?? data.thumbnail?.source ?? null;
	} catch {
		return null;
	}
}

interface PictureTopic {
	title: string;
	hint1: string;
	hint2: string;
	category: string;
	subcategory: string;
}

async function generatePictureTossups(params: {
	setId: string;
	count: number;
	theme: string;
	difficulty: string;
}): Promise<void> {
	const { setId, count, theme, difficulty } = params;
	const db = getDb();

	log.info(`[${setId}] Picture generation: requesting ${count} topics for theme="${theme}"`);

	const prompt = `Generate exactly ${count} Wikipedia article titles for picture quiz questions about "${theme}" at "${difficulty}" level.

Requirements:
- Choose NICHE, non-obvious subjects — avoid the single most famous example of any category
- Prefer: specific artworks (not just "Mona Lisa"), lesser-known landmarks, specific scientific instruments or specimens, particular historical photographs, regional fauna/flora, specific architectural details, lesser-known cultural artefacts
- Each title must have a Wikipedia article with an image
- For each topic write TWO hint sentences in pyramidal style:
  - Sentence 1 (harder): a specific, expert-level visual or contextual detail visible in or associated with the image that only an expert would know
  - Sentence 2 (medium): a moderately specific fact about the subject — NOT a giveaway, but something a knowledgeable player could use alongside the image to narrow it down

Output ONLY a JSON array, no markdown. Example:
[
  {
    "title": "Arnolfini Portrait",
    "hint1": "A convex mirror in the background reflects two additional figures entering the room, one widely believed to be the painter himself, while the Latin inscription above reads 'Jan van Eyck was here 1434'.",
    "hint2": "This oil painting depicting a Flemish merchant and his elaborately dressed companion is one of the earliest uses of oil paint in the northern European tradition.",
    "category": "Fine Arts",
    "subcategory": "Painting"
  }
]`;

	let topics: PictureTopic[];
	try {
		const raw = await runCliChatSimple({
			prompt,
			systemPrompt: "You are a quiz bowl expert. Output only valid JSON arrays.",
			model: "haiku",
		});
		const cleaned = raw.replace(/```[a-z]*\n?/gi, "").trim();
		const parsed = JSON.parse(cleaned) as PictureTopic[];
		if (!Array.isArray(parsed)) throw new Error("Not an array");
		topics = parsed.slice(0, count);
	} catch (err) {
		log.error(`[${setId}] Picture topic generation failed: ${err instanceof Error ? err.message : err}`);
		return;
	}

	log.info(`[${setId}] Fetching Wikipedia images for ${topics.length} topics`);

	const results = await Promise.all(
		topics.map(async (t) => {
			const imageUrl = await fetchWikiImage(t.title);
			return imageUrl ? { ...t, imageUrl } : null;
		}),
	);

	const valid = results.filter((r): r is PictureTopic & { imageUrl: string } => r !== null);
	log.info(`[${setId}] Picture: ${valid.length}/${topics.length} topics have images`);

	if (valid.length === 0) return;

	await db.tossup.createMany({
		data: valid.map((t) => ({
			setId,
			question: `${t.hint1} ${t.hint2}`,
			answer: t.title,
			powerMarkIndex: null,
			imageUrl: t.imageUrl,
			category: t.category,
			subcategory: t.subcategory,
			difficulty,
		})),
	});

	log.info(`[${setId}] Saved ${valid.length} picture tossups`);
}

export async function runGeneration(params: {
	setId: string;
	theme: string;
	difficulty: string;
	tossupCount: number;
	bonusCount: number;
	pictureCount?: number;
	model?: string;
}): Promise<void> {
	const { setId, theme, difficulty, tossupCount, bonusCount, pictureCount = 0, model } = params;
	// Picture questions are drawn from the tossup budget; written tossups fill the remainder
	const writtenTossupCount = Math.max(0, tossupCount - pictureCount);
	const db = getDb();

	try {
		await db.questionSet.update({
			where: { id: setId },
			data: { status: "generating" },
		});

		// Phase 1: Answer Planning (regular tossups + bonuses)
		log.info(`[${setId}] Phase 1: generating answer plan (${writtenTossupCount} written tossups, ${bonusCount} bonuses, ${pictureCount} picture)`);

		const planPrompt = `Generate a JSON object with two arrays:
- "tossup_answers": ${writtenTossupCount} unique answer strings for tossups about "${theme}" at ${difficulty} difficulty
- "bonus_answers": ${bonusCount} unique answer strings for bonuses about "${theme}" at ${difficulty} difficulty

Each answer should be a specific, notable topic suitable for a quiz bowl question at the ${difficulty} level.
All answers must be distinct across both arrays — no duplicates whatsoever.
Output ONLY the JSON object, no other text, no markdown fences.`;

		const tasks: Promise<unknown>[] = [];

		if (writtenTossupCount > 0 || bonusCount > 0) {
			const planResult = await runCliChatSimple({
				prompt: planPrompt,
				systemPrompt: "You are a quiz bowl expert. Output only valid JSON.",
				model: "haiku",
			});

			const jsonMatch = planResult.match(/\{[\s\S]*\}/);
			if (!jsonMatch) throw new Error("Answer planning failed: no JSON found in response");

			const plan = JSON.parse(jsonMatch[0]) as {
				tossup_answers: string[];
				bonus_answers: string[];
			};

			if (!plan.tossup_answers?.length && writtenTossupCount > 0) throw new Error("Answer planning returned no tossup answers");
			if (!plan.bonus_answers?.length && bonusCount > 0) throw new Error("Answer planning returned no bonus answers");

			log.info(`[${setId}] Phase 1 complete: ${plan.tossup_answers?.length ?? 0} tossup answers, ${plan.bonus_answers?.length ?? 0} bonus answers`);

			// Phase 2: Parallel Question Writing
			log.info(`[${setId}] Phase 2: writing questions in parallel`);

			if (writtenTossupCount > 0) {
				const answerList = plan.tossup_answers.slice(0, writtenTossupCount).join("\n- ");
				const tossupPrompt = `Write ${writtenTossupCount} tossups for these specific answers:\n- ${answerList}\n\nEach tossup must be about its assigned answer. CRITICAL: the answer word and any variant or near-homophone of it must NEVER appear anywhere in the question text — refer to the subject only as 'this person', 'this country', 'this work', 'this element', etc. Save all via mcp__3roads__save_tossups_batch with setId "${setId}".`;

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
		}

		// Picture tossups run in parallel with regular generation
		if (pictureCount > 0) {
			tasks.push(
				generatePictureTossups({ setId, count: pictureCount, theme, difficulty }),
			);
		}

		const results = await Promise.allSettled(tasks);

		const errors: string[] = [];
		for (const r of results) {
			if (r.status === "rejected") {
				errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
			} else if (r.value && typeof r.value === "object" && "ok" in r.value && !(r.value as { ok: boolean }).ok) {
				errors.push((r.value as { error?: string }).error || "Unknown CLI error");
			}
		}

		if (errors.length > 0) {
			log.error(`[${setId}] Phase 2 errors: ${errors.join("; ")}`);
			await db.questionSet.update({ where: { id: setId }, data: { status: "error" } });
		} else {
			log.info(`[${setId}] Generation complete`);
			await db.questionSet.update({ where: { id: setId }, data: { status: "complete" } });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`[${setId}] Generation failed: ${msg}`);
		await db.questionSet.update({ where: { id: setId }, data: { status: "error" } });
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
