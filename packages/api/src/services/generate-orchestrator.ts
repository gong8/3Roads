import { createLogger, getDb } from "@3roads/shared";
import { runLlmChat, runLlmChatSimple } from "./llm-chat.js";

const log = createLogger("api:orchestrator");

/** Most tossups (and bonuses) a single set can ask for. */
export const MAX_SET_QUESTIONS = 50;
/** Longest question-style description passed to the prompts. */
export const MAX_STYLE_LENGTH = 300;
/** Questions written per LLM call — keeps each reply well inside output limits and quality steady. */
const TOSSUPS_PER_BATCH = 25;
const BONUSES_PER_BATCH = 25;
/** LLM calls in flight at once while writing a set. */
const MAX_PARALLEL_CALLS = 6;

export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** Like Promise.allSettled over thunks, but with at most `limit` running at once. */
export async function settleLimited<T>(jobs: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
	const results: PromiseSettledResult<T>[] = new Array(jobs.length);
	let next = 0;
	const worker = async () => {
		while (next < jobs.length) {
			const i = next++;
			try {
				results[i] = { status: "fulfilled", value: await jobs[i]() };
			} catch (reason) {
				results[i] = { status: "rejected", reason };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
	return results;
}

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT CONSTRAINTS:",
	"- Use ONLY MCP tools prefixed with mcp__3roads__ to save questions. Never attempt to use filesystem, code editing, web browsing, or any non-MCP tools.",
	"- Always include category, subcategory, and difficulty for each question.",
	"- NEVER include the answer word, any variant of it, or anything that sounds like it ANYWHERE in the question text. Replace it with a placeholder like 'this country', 'this author', 'this element', 'this work', 'this region', etc. as appropriate. The answer must not be nameable from any word in the question itself.",
	"- NEVER write clues that transparently give away the answer through etymology, word games, or trivial restatement.",
	"- Every tossup must be strictly pyramidal: hardest clues first, (*) placed immediately before the first word that gives the answer away (1/3-1/2 through), giveaway last.",
	"- In every answer field, wrap the part a player MUST say in {curly braces}; everything outside the braces is optional. Brace only the distinctive name; generic descriptor words like River, Lake, Mount, Strait of, Battle of, line, a first name, or a territorial qualifier like \"of England\" stay OUTSIDE the braces. Examples: \"{Ganges} River\", \"Lake {Baikal}\", \"Strait of {Gibraltar}\", \"{Bakerloo} line\", \"Johann Sebastian {Bach}\", \"{Ely}, Cambridgeshire\", \"Battle of {Hastings}\", \"{James I} of England\". Dates and years stay outside the braces: \"{Chilean coup} of 1973\", \"Battle of {Hastings}\". A compound name whose first part is what people actually say braces only that part: \"{CRISPR}-Cas9\", \"{Hubble} Space Telescope\". Brace the whole answer only when every word is essential: \"{France}\", \"{mitochondria}\", \"{The Great Gatsby}\". Add common alternative names and phrasings as accepts, e.g. \"{Fibonacci} sequence [accept {Fibonacci} series or {Fibonacci} numbers]\". Alternatives go in square brackets and get braces too: \"{DNA} [accept {deoxyribonucleic acid}]\".",
].join("\n");

/** Compare answers loosely: "{Strait of Gibraltar}" and "the strait of gibraltar" are the same answer. */
function answerKey(answer: string): string {
	return answer
		.replace(/\[[^\]]*\]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/^the\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** True when two answers name the same thing, including "Baikal" vs "Lake Baikal". */
export function sameAnswer(a: string, b: string): boolean {
	const ka = answerKey(a);
	const kb = answerKey(b);
	if (!ka || !kb) return false;
	return ka === kb || ` ${ka} `.includes(` ${kb} `) || ` ${kb} `.includes(` ${ka} `);
}

/** Difficulty comes from the clues, not the answer: a famous answer needs correspondingly obscure clues. */
const CLUE_OBSCURITY_RULES = `
## CLUE OBSCURITY
Difficulty is set by the clues, not just the answer. The better known the answer, the more obscure its clues must be.
- At college level and above, players already know an answer's textbook facts. Clues must be niche: specific people, dates, works, technical details, lesser-known episodes and connections that only a well-read specialist would recognise.
- An answer's famous facts (the ones in its encyclopedia summary or any general-knowledge quiz) may appear only in the giveaway, or not at all.
- Some clues identify the answer outright for a knowledgeable player, however technical they sound: where it is (its country, state, region or city), its size or other headline statistic, its defining superlative ("the world's largest..."), the year it was founded or listed, its creator, discoverer or namesake, and its best-known products, works, brands or lines (for LEGO: Mindstorms, Technic, licensed sets). These belong after the power mark, never before it.
- Words that point straight at the answer are giveaways wherever they appear, even inside a clue about something else: the people, groups, places and terms most associated with it. For the Rwandan Genocide, "Hutu", "Tutsi", "Kigali" and "Habyarimana" all give it away, so a lead-in naming "the Hutu Ten Commandments" is ruined however obscure the editorial is.
- Test every clue before the power mark: a strong player at the target difficulty, hearing everything up to that point, should still be unsure what the answer is. If the clue would let them buzz confidently, it is not power material.
- Example: for the River Thames at Regular College, the Great Stink, Bazalgette's embankments, the Thames Barrier and the Boat Race are all far too easy to lead with. Lead instead with something like a specific named lock or tributary, a little-known historical episode, or an obscure literary appearance.
- Example: for the Great Barrier Reef at Regular College, Raine Island's turtle rookery is a middle clue at best, and its location off Queensland, its area and its World Heritage listing are giveaway material. A suitable lead-in is the 1928-29 expedition led by Maurice Yonge that spent a year on the Low Isles studying coral biology.`;

/** What each difficulty means for a tossup's lead-in, power and giveaway, and for a bonus's three parts. */
const DIFFICULTY_PROFILES: Record<string, string> = {
	"Middle School": "Lead-in: a fact a keen middle schooler might know. Giveaway: classroom knowledge everyone has. Bonus parts: nearly every team gets the easy part, most get the hard one.",
	"Easy High School": "Lead-in: a fact from a good textbook chapter on the topic. Giveaway: common knowledge. Bonus parts: easy ~95% of teams, medium ~60%, hard ~30%.",
	"Regular High School": "Lead-in: a specific fact that only well-read high school players know. Power: a fact strong players recognise. Giveaway: something every regular player knows. Bonus parts: easy ~90%, medium ~50%, hard ~20%.",
	"Hard High School": "Lead-in: a detail from beyond the high school curriculum that only the best high school players in this subject know. Giveaway: standard textbook knowledge. Bonus parts: easy ~85%, medium ~40%, hard ~15%.",
	"Easy College": "Lead-in: a detail a strong college player who studies this subject would know, but most would not. Power: facts from an undergraduate course on the topic. Giveaway: something any college quiz player knows. Bonus parts: easy ~90%, medium ~50%, hard ~20%.",
	"Regular College": "Lead-in: a deep cut that perhaps one player in twenty who specialises in this subject would know: a minor work, a named secondary figure, a specific study, experiment, court case, passage or technical detail. Middle clues: facts from upper-level undergraduate study of the topic, still beyond most players. Power: only strong specialists have buzzed by this point. Giveaway: a fact a typical college quiz player knows, which may still be beyond the general public. Bonus parts: easy ~80% of teams, medium ~40%, hard ~10%.",
	"Hard College": "Lead-in: a fact almost nobody in the room knows: graduate-level or archival detail. Power: deep specialist knowledge. Giveaway: a fact strong college players know, not a general-knowledge fact. Bonus parts: easy ~70%, medium ~30%, hard ~5%.",
	Open: "Lead-in: expert-level, research-literature detail. Even the middle clues are beyond nearly all players. Giveaway: something a serious, experienced quiz player knows. Bonus parts: easy ~60%, medium ~25%, hard rarely converted.",
};

function difficultyCalibration(difficulty: string): string {
	return `## DIFFICULTY CALIBRATION
Target: "${difficulty}". The levels, easiest to hardest:
- Middle School: common curriculum topics, straightforward clues, well-known answers
- Easy High School: introductory-level academic content, accessible to newer players
- Regular High School: standard varsity tournament level (e.g., NAQT IS-A)
- Hard High School: championship-level high school (e.g., PACE NSC, HSNCT)
- Easy College: novice collegiate level (e.g., ACF Fall)
- Regular College: standard collegiate level (e.g., ACF Regionals)
- Hard College: difficult collegiate level (e.g., ACF Nationals)
- Open: expert-level open tournaments (e.g., Chicago Open, EFT)

What "${difficulty}" means in practice: ${DIFFICULTY_PROFILES[difficulty] ?? "match the conventions of tournaments at this level."}

Writers consistently make questions too easy. If a clue feels fairly obscure to you, at college level it is a middle clue, not a lead-in. When unsure between two clues, choose the harder one.
${CLUE_OBSCURITY_RULES}`;
}

/** The user's description of the kind of question they want, which overrides the default format. */
function styleSection(style: string | undefined): string {
	if (!style) return "";
	return `
## REQUESTED STYLE
The user asked for questions in this style: "${style}"
Follow it. Where it conflicts with the format rules above (pyramidal structure, power mark, "For 10 points", leadin wording, number of sentences), the requested style wins. These rules still always apply: save through the batch tool, fill the answer field using the brace format below, and never reveal the answer in the question text.
The style changes the FORMAT, never the DIFFICULTY. Clues must still be calibrated to the target difficulty and follow the clue obscurity rules above. A short question has room for only one or two clues, so each must be a hard one: never spend a short question on the answer's most famous facts.
`;
}

function buildTossupSystemPrompt(setId: string, difficulty: string, theme: string, style?: string): string {
	return `You are an expert quiz bowl question writer producing competition-quality academic questions.

Set ID: ${setId}
Target difficulty: ${difficulty}
Theme: ${theme}

${difficultyCalibration(difficulty)}

## TOSSUP FORMAT (Pyramidal Structure)
Each tossup MUST follow strict pyramidal structure:
- **First 1-3 sentences:** Obscure, specific facts that only deep experts would know.
- **Middle sentences:** Moderately difficult facts that knowledgeable players would recognize.
- **Power mark placement:** Insert the literal text "(*)" (with parentheses) immediately BEFORE the first word that gives the answer away to a knowledgeable player: the key word of a famous work, name, event, or nickname. Everything before (*) must be obscure enough to earn power, so that word always comes right AFTER (*), never before it. This usually means (*) sits mid-sentence. It typically lands 1/3 to 1/2 through the question. WRONG: "...sketched a man inscribed in a circle and square in the Vitruvian study. (*)" RIGHT: "...sketched a man inscribed in a circle and square in the (*) Vitruvian study."
- **Final sentence (giveaway):** A well-known identifying fact, preceded by "For 10 points," or "FTP,"
- **Answer:** Put the answer ONLY in the separate "answer" field. The question text must end with the giveaway sentence — never append "ANSWER: ..." to it.

The giveaway clue must still require SOME knowledge — it should uniquely identify the answer but not be a direct restatement.

## REFERRING TO THE ANSWER
- **Every sentence** must refer to the answer directly with a "this <type>" phrase — "this food", "this author", "this country", "this term", "this element". Pick one type at the start and use it consistently through the whole tossup, including the "For 10 points" line.
- Every clue must be a fact ABOUT the answer itself, not a free-standing story about a related person, place, or thing that only connects to the answer at the end.
- The first sentence must NOT name or describe the answer's namesake, eponym, or etymological source, and must NOT use the answer's single most famous fact. Those are middle or late clues.

Example — answer "sandwich":
- BAD opening: "A British earl ordered cold meat between slices of bread so he could keep gambling." (doesn't say "this food", and gives away the namesake story immediately)
- GOOD opening: "A 19th-century cookbook by Eliza Leslie gave a recipe for a ham version of this food calling for mustard." (obscure, and refers to the answer as "this food")

## WORKFLOW
1. Write ALL tossups, then audit each one before saving: list every clue before (*) and ask whether a strong "${difficulty}" player would buzz confidently on it. Replace any clue that fails with a more obscure one. Use only facts you are certain are true: an invented clue is worse than an easy one.
2. Call mcp__3roads__save_tossups_batch ONCE with setId "${setId}" and the full array.
3. For the difficulty field in each question, use "${difficulty}".
4. Do NOT call individual save_tossup tools — always use the batch version.
${styleSection(style)}${SYSTEM_PROMPT_SUFFIX}`;
}

function buildBonusSystemPrompt(setId: string, difficulty: string, theme: string, style?: string): string {
	return `You are an expert quiz bowl question writer producing competition-quality academic questions.

Set ID: ${setId}
Target difficulty: ${difficulty}
Theme: ${theme}

${difficultyCalibration(difficulty)}

## BONUS FORMAT
Each bonus has:
- **Leadin:** A plain declarative statement naming the subject of the bonus — NOT a clue, NOT a question, NOT a hint. It tells the players what the bonus is about. Examples: "This bonus is about the French Revolution.", "Answer these questions about mitosis.", "For 10 points each, name these works by Shakespeare." Never write the leadin as a riddle or teaser like "This country is renowned for its linguistic diversity" — instead write "This bonus is about Switzerland."
- **Part 1 [10]:** Easiest — most players at this difficulty should get it
- **Part 2 [10]:** Medium — requires solid knowledge
- **Part 3 [10]:** Hardest — challenges even strong players
- Each part must have a DIFFERENT answer from the other parts and from all other questions in the set
- CRITICAL: No part's answer may appear in or be trivially inferable from the leadin. If the leadin is "This bonus is about Goya's Saturn Devouring His Son," you must NOT ask for Goya or Saturn as part answers — those names are stated in the leadin and would be immediate giveaways. Choose part answers that are substantive facts *about* the leadin subject, not components of its name.

## WORKFLOW
1. Write ALL bonuses, then call mcp__3roads__save_bonuses_batch ONCE with setId "${setId}" and the full array.
2. For the difficulty field in each question, use "${difficulty}".
3. Do NOT call individual save_bonus tools — always use the batch version.
${styleSection(style)}${SYSTEM_PROMPT_SUFFIX}`;
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
		// Prefer thumbnail (already a compressed derivative served by Wikipedia's CDN).
		// Only fall back to originalimage if no thumbnail exists.
		return data.thumbnail?.source ?? data.originalimage?.source ?? null;
	} catch {
		return null;
	}
}

interface PictureTopic {
	title: string;
	answer?: string;
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
	/** Answers already used elsewhere in the set; picture topics must not repeat them */
	excludeAnswers: string[];
	userId: string;
	model?: string;
	onCost?: (usd: number) => void;
}): Promise<void> {
	const { setId, count, theme, difficulty, excludeAnswers, userId, model, onCost } = params;
	const db = getDb();

	const MAX_ATTEMPTS = 3;
	const collected: (PictureTopic & { imageUrl: string })[] = [];
	const usedTitles = new Set<string>();

	for (let attempt = 1; attempt <= MAX_ATTEMPTS && collected.length < count; attempt++) {
		const needed = count - collected.length;
		log.info(`[${setId}] Picture generation attempt ${attempt}/${MAX_ATTEMPTS}: requesting ${needed} topics`);

		const excluded = [...excludeAnswers, ...usedTitles];
		const excludeClause = excluded.length > 0
			? `\nDo NOT generate topics for any of these subjects, which are already used elsewhere in the set: ${excluded.join(", ")}.`
			: "";

		const prompt = `Generate exactly ${needed} Wikipedia article titles for picture quiz questions that fit the theme "${theme}" at "${difficulty}" difficulty.${excludeClause}

Difficulty calibration for subject selection:
- Middle School / Easy High School: well-known, recognisable subjects — famous paintings, iconic landmarks, well-known species, major historical figures
- Regular High School: moderately well-known subjects that a curious student would recognise — notable but not the single most famous example
- Hard High School / Easy College: less obvious subjects within the theme — specific works, regional examples, notable but not household-name subjects
- Regular College and above: genuinely challenging — specific lesser-known works, technical specimens, obscure but real subjects

Current difficulty is "${difficulty}" — calibrate subject familiarity accordingly. Subjects must be directly related to the theme "${theme}".

Each title must be a real Wikipedia article that has an image.
Also give an "answer": the title with the part a player must say wrapped in {braces}. Generic descriptor words stay outside the braces: "Strait of {Gibraltar}", "{Ganges} River", "Lake {Baikal}". Brace the whole title only when every word is essential: "{Arnolfini Portrait}".
For each topic write TWO hint sentences in pyramidal style:
- Sentence 1 (harder): a specific contextual or visual detail that a knowledgeable player would recognise but not a casual observer
- Sentence 2 (medium): a broader fact about the subject that helps confirm an answer — not a direct giveaway, but useful alongside the image

CRITICAL: The hint sentences must NEVER contain the title, the subject's name, or any recognisable variant or abbreviation of it. Refer to the subject only as "this work", "this painting", "this person", "this species", "this building", etc. as appropriate. The answer must not be nameable from the hint text alone.

Output ONLY a JSON array, no markdown. Example:
[
  {
    "title": "Arnolfini Portrait",
    "answer": "{Arnolfini Portrait}",
    "hint1": "A convex mirror in the background reflects two additional figures entering the room, one widely believed to be the painter himself, while the Latin inscription above reads 'Jan van Eyck was here 1434'.",
    "hint2": "This oil painting depicting a Flemish merchant and his elaborately dressed companion is one of the earliest uses of oil paint in the northern European tradition.",
    "category": "Fine Arts",
    "subcategory": "Painting"
  }
]`;

		let topics: PictureTopic[];
		try {
			const raw = await runLlmChatSimple({
				prompt,
				systemPrompt: "You are a quiz bowl expert. Output only valid JSON arrays.",
				model,
				userId,
				onCost,
			});
			const cleaned = raw.replace(/```[a-z]*\n?/gi, "").trim();
			const parsed = JSON.parse(cleaned) as PictureTopic[];
			if (!Array.isArray(parsed)) throw new Error("Not an array");
			topics = parsed
				.filter((t) => {
					const clash = excludeAnswers.find((a) => sameAnswer(a, t.title));
					if (clash) log.warn(`[${setId}] Dropping picture topic "${t.title}" — duplicates set answer "${clash}"`);
					return !clash;
				})
				.slice(0, needed);
		} catch (err) {
			log.error(`[${setId}] Picture topic generation failed (attempt ${attempt}): ${err instanceof Error ? err.message : err}`);
			break;
		}

		log.info(`[${setId}] Fetching Wikipedia images for ${topics.length} topics`);

		const results = await Promise.all(
			topics.map(async (t) => {
				usedTitles.add(t.title);
				const imageUrl = await fetchWikiImage(t.title);
				return imageUrl ? { ...t, imageUrl } : null;
			}),
		);

		const valid = results.filter((r): r is PictureTopic & { imageUrl: string } => r !== null);
		log.info(`[${setId}] Picture attempt ${attempt}: ${valid.length}/${topics.length} topics have images`);
		collected.push(...valid);
	}

	log.info(`[${setId}] Picture: collected ${collected.length}/${count} tossups after retries`);

	if (collected.length === 0) return;

	await db.tossup.createMany({
		data: collected.slice(0, count).map((t) => ({
			setId,
			question: `${t.hint1} ${t.hint2}`,
			// Fall back to the bare title if the model dropped the field or braced a different string
			answer: t.answer && answerKey(t.answer) === answerKey(t.title) ? t.answer : t.title,
			powerMarkIndex: null,
			imageUrl: t.imageUrl,
			category: t.category,
			subcategory: t.subcategory,
			difficulty,
		})),
	});

	log.info(`[${setId}] Saved ${Math.min(collected.length, count)} picture tossups`);
}

/** Last line of defence: a set must never contain two tossups with the same answer. Keeps the earliest. */
async function removeDuplicateTossups(setId: string): Promise<void> {
	const db = getDb();
	const tossups = await db.tossup.findMany({ where: { setId }, orderBy: { createdAt: "asc" }, select: { id: true, answer: true } });
	const kept: string[] = [];
	const duplicateIds: string[] = [];
	for (const t of tossups) {
		const clash = kept.find((k) => sameAnswer(k, t.answer));
		if (clash) {
			log.warn(`[${setId}] Removing duplicate tossup "${t.answer}" (same answer as "${clash}")`);
			duplicateIds.push(t.id);
		} else {
			kept.push(t.answer);
		}
	}
	if (duplicateIds.length > 0) await db.tossup.deleteMany({ where: { id: { in: duplicateIds } } });
}

/** Candidate answers asked for per answer needed; the extra are what random selection picks from. */
const POOL_FACTOR = 3;
/** Earlier sets on the same theme whose answers a new packet avoids. */
const PRIOR_SETS_TO_AVOID = 20;
const MAX_AVOIDED_ANSWERS = 400;

export function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/** "{Ganges} River [accept Ganga]" → "Ganges River": the answer itself, for prompts and comparisons. */
export function plainAnswer(answer: string): string {
	return answer.replace(/\s*\[[^\]]*\]/g, "").replace(/[{}]/g, "").trim();
}

/** Answers in recent sets on this theme the user can see, so a new packet doesn't repeat them. */
async function answersOnTheme(theme: string, userId: string, skipSetIds: string[]): Promise<string[]> {
	const db = getDb();
	const key = theme.trim().toLowerCase();
	// SQLite has no case-insensitive equals in Prisma, so match themes here; the set table is small
	const sets = await db.questionSet.findMany({
		where: { OR: [{ isPrivate: false }, { ownerId: userId }] },
		select: { id: true, theme: true },
		orderBy: { createdAt: "desc" },
	});
	const setIds = sets
		.filter((s) => s.theme.trim().toLowerCase() === key && !skipSetIds.includes(s.id))
		.slice(0, PRIOR_SETS_TO_AVOID)
		.map((s) => s.id);
	if (setIds.length === 0) return [];
	const [tossups, parts] = await Promise.all([
		db.tossup.findMany({ where: { setId: { in: setIds } }, select: { answer: true } }),
		db.bonusPart.findMany({ where: { bonus: { setId: { in: setIds } } }, select: { answer: true } }),
	]);
	const answers = [...new Set([...tossups, ...parts].map((a) => plainAnswer(a.answer)).filter(Boolean))];
	return answers.slice(0, MAX_AVOIDED_ANSWERS);
}

/** General knowledge packets follow this subject mix, given per 20 questions. */
const GENERAL_KNOWLEDGE_MIX: { subject: string; per20: number; areas: string[] }[] = [
	{ subject: "History", per20: 4, areas: ["British history", "European history", "world history"] },
	{ subject: "Literature", per20: 4, areas: ["drama", "poetry", "novels", "classics"] },
	{ subject: "Science", per20: 4, areas: ["biology", "chemistry", "physics", "mathematics", "computer science"] },
	{ subject: "Fine Arts", per20: 2, areas: ["classical music", "opera", "painting", "sculpture", "architecture"] },
	{ subject: "Religion", per20: 1, areas: ["sacred texts", "religious history", "world beliefs"] },
	{ subject: "Mythology", per20: 1, areas: ["Greek and Roman myth", "Norse myth", "Egyptian myth", "world myths"] },
	{ subject: "Philosophy", per20: 1, areas: ["philosophical movements", "philosophers"] },
	{ subject: "Social Science", per20: 1, areas: ["economics", "psychology", "sociology", "linguistics", "anthropology"] },
	{ subject: "Pop Culture", per20: 1, areas: ["film", "television", "sports", "video games", "contemporary music"] },
	{ subject: "Geography", per20: 1, areas: ["world geography", "current events", "miscellaneous academic"] },
];
const GENERAL_KNOWLEDGE_THEMES = new Set(["general knowledge", "general", "gk", "trivia", "general trivia"]);
/** Candidate answers asked for per general knowledge slot; the code picks one at random. */
const CANDIDATES_PER_SLOT = 3;

function isGeneralKnowledge(theme: string): boolean {
	return GENERAL_KNOWLEDGE_THEMES.has(theme.trim().toLowerCase());
}

function randomItem<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

/** "Literature: poetry"-style slots for `count` questions: whole shares of the mix, the rest drawn by weight. */
function generalKnowledgeSlots(count: number): string[] {
	const slot = (m: (typeof GENERAL_KNOWLEDGE_MIX)[number]) => `${m.subject}: ${randomItem(m.areas)}`;
	const slots: string[] = [];
	for (const m of GENERAL_KNOWLEDGE_MIX) {
		for (let i = 0; i < Math.floor((count * m.per20) / 20); i++) slots.push(slot(m));
	}
	while (slots.length < count) {
		let r = Math.random() * 20;
		const m = GENERAL_KNOWLEDGE_MIX.find((x) => (r -= x.per20) < 0) ?? GENERAL_KNOWLEDGE_MIX[0];
		slots.push(slot(m));
	}
	return shuffle(slots);
}

interface PlannedAnswers {
	tossupAnswers: string[];
	bonusAnswers: string[];
	/** Subject slot per answer ("Literature: poetry"), for general knowledge packets */
	subjects: Map<string, string>;
}

/**
 * Answers to write questions for, chosen up front so batches written in parallel never collide.
 * The model lists more candidates than needed and the code picks at random, so repeated runs on
 * one theme don't all get its most obvious answers.
 */
async function planAnswers(params: {
	theme: string;
	difficulty: string;
	/** How the user wants questions written, e.g. "university challenge style" */
	style?: string;
	tossupCount: number;
	bonusCount: number;
	/** Answers already used (e.g. earlier in an infinite game); the plan must avoid them */
	excludeAnswers?: string[];
	model?: string;
	userId: string;
	onCost?: (usd: number) => void;
}): Promise<PlannedAnswers> {
	if (isGeneralKnowledge(params.theme)) return planGeneralKnowledge(params);
	const { theme, difficulty, style, tossupCount, bonusCount, excludeAnswers = [], model, userId, onCost } = params;
	const excludeClause = excludeAnswers.length > 0
		? `\nThese answers have already been used, so do NOT use any of them or anything about the same specific subject: ${excludeAnswers.join("; ")}.`
		: "";
	// The style can decide what kind of thing an answer is (a theorem, a date, a person)
	const styleClause = style
		? `
The questions will be written in this style: "${style}". Pick answers that suit it.`
		: "";
	const planPrompt = `Generate a JSON object with two arrays:
- "tossup_answers": ${tossupCount * POOL_FACTOR} unique candidate answer strings for tossups about "${theme}" at ${difficulty} difficulty
- "bonus_answers": ${bonusCount * POOL_FACTOR} unique candidate answer strings for bonuses about "${theme}" at ${difficulty} difficulty

Each answer should be a specific, notable topic suitable for a quiz bowl question at the ${difficulty} level.
Range widely: spread the candidates across the theme's different sub-areas, periods and regions, and mix well-known answers with less obvious ones. Do not just list the most famous examples.
All answers must be distinct across both arrays — no duplicates whatsoever.
Bonus answers must not be about the same specific subject as any tossup answer. If a tossup is about a painting, the bonus must not be about that same painting, its painter, or its depicted subject. Keep tossup and bonus topics clearly separated.${styleClause}${excludeClause}
Output ONLY the JSON object, no other text, no markdown fences.`;

	const planResult = await runLlmChatSimple({
		prompt: planPrompt,
		systemPrompt: "You are a quiz bowl expert. Output only valid JSON.",
		model,
		userId,
		onCost,
	});

	const jsonMatch = planResult.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Answer planning failed: no JSON found in response");

	const plan = JSON.parse(jsonMatch[0]) as {
		tossup_answers: string[];
		bonus_answers: string[];
	};

	if (!plan.tossup_answers?.length && tossupCount > 0) throw new Error("Answer planning returned no tossup answers");
	if (!plan.bonus_answers?.length && bonusCount > 0) throw new Error("Answer planning returned no bonus answers");

	// Pick at random from the candidates, skipping any the plan slipped in that are already used
	// (or already picked), so a repeat costs a candidate rather than a slot
	const pick = (candidates: string[], count: number, taken: string[]): string[] => {
		const picked: string[] = [];
		for (const a of shuffle(candidates)) {
			if (picked.length >= count) break;
			if (typeof a !== "string" || !a.trim()) continue;
			if ([...excludeAnswers, ...taken, ...picked].some((used) => sameAnswer(used, a))) continue;
			picked.push(a);
		}
		return picked;
	};
	const tossupAnswers = pick(plan.tossup_answers ?? [], tossupCount, []);
	const bonusAnswers = pick(plan.bonus_answers ?? [], bonusCount, tossupAnswers);
	return { tossupAnswers, bonusAnswers, subjects: new Map() };
}

/**
 * General knowledge: each question gets a subject slot from the fixed mix, the model suggests a
 * few answers per slot, and the code picks one at random.
 */
async function planGeneralKnowledge(params: Parameters<typeof planAnswers>[0]): Promise<PlannedAnswers> {
	const { difficulty, style, tossupCount, bonusCount, excludeAnswers = [], model, userId, onCost } = params;
	const tossupSlots = generalKnowledgeSlots(tossupCount);
	const bonusSlots = generalKnowledgeSlots(bonusCount);
	const numbered = (slots: string[]) => slots.map((s, i) => `${i + 1}. ${s}`).join("\n");
	const excludeClause = excludeAnswers.length > 0
		? `\nThese answers have already been used, so do NOT use any of them or anything about the same specific subject: ${excludeAnswers.join("; ")}.`
		: "";
	const styleClause = style ? `\nThe questions will be written in this style: "${style}". Pick answers that suit it.` : "";
	const prompt = `For each numbered slot below, suggest ${CANDIDATES_PER_SLOT} different answers that fit its subject, for quiz bowl questions at ${difficulty} difficulty. Any suitable answer in the subject will do: pick freely across periods and regions rather than the most famous examples (for "Literature: poetry", any poet or poem, not just Shakespeare's sonnets).
All answers must be distinct, and no two slots may be about the same specific subject.${styleClause}${excludeClause}

Tossup slots:
${numbered(tossupSlots) || "(none)"}

Bonus slots:
${numbered(bonusSlots) || "(none)"}

Output ONLY a JSON object {"tossups": [[...], ...], "bonuses": [[...], ...]} with one array of ${CANDIDATES_PER_SLOT} answer strings per slot, in slot order. No other text, no markdown fences.`;

	const raw = await runLlmChatSimple({
		prompt,
		systemPrompt: "You are a quiz bowl expert. Output only valid JSON.",
		model,
		userId,
		onCost,
	});
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (!jsonMatch) throw new Error("Answer planning failed: no JSON found in response");
	const plan = JSON.parse(jsonMatch[0]) as { tossups?: unknown[]; bonuses?: unknown[] };

	const subjects = new Map<string, string>();
	const taken: string[] = [];
	// One random fresh candidate per slot; a slot whose candidates are all used is dropped
	const fill = (slots: string[], candidates: unknown[] | undefined): string[] => {
		const answers: string[] = [];
		slots.forEach((slot, i) => {
			const options = Array.isArray(candidates?.[i]) ? (candidates[i] as unknown[]) : [];
			const answer = shuffle(options).find(
				(a): a is string =>
					typeof a === "string" && !!a.trim() && ![...excludeAnswers, ...taken].some((used) => sameAnswer(used, a)),
			);
			if (!answer) return;
			answers.push(answer);
			taken.push(answer);
			subjects.set(answer, slot);
		});
		return answers;
	};
	const tossupAnswers = fill(tossupSlots, plan.tossups);
	const bonusAnswers = fill(bonusSlots, plan.bonuses);
	if (tossupAnswers.length === 0 && tossupCount > 0) throw new Error("Answer planning returned no tossup answers");
	if (bonusAnswers.length === 0 && bonusCount > 0) throw new Error("Answer planning returned no bonus answers");
	return { tossupAnswers, bonusAnswers, subjects };
}

/** One LLM call per batch of planned answers; each call saves its questions into the set. */
function writeJobs(params: {
	setId: string;
	theme: string;
	difficulty: string;
	style?: string;
	tossupAnswers: string[];
	bonusAnswers: string[];
	subjects?: Map<string, string>;
	model?: string;
	userId: string;
	onCost?: (usd: number) => void;
}): (() => Promise<unknown>)[] {
	const { setId, theme, difficulty, style, tossupAnswers, bonusAnswers, subjects, model, userId, onCost } = params;
	const withSubject = (a: string) => (subjects?.has(a) ? `${a} (subject: ${subjects.get(a)}; use it for category and subcategory)` : a);
	const jobs: (() => Promise<unknown>)[] = [];

	for (const batch of chunk(tossupAnswers, TOSSUPS_PER_BATCH)) {
		const answerList = batch.map(withSubject).join("\n- ");
		const tossupPrompt = `Write ${batch.length} tossups for these specific answers:\n- ${answerList}\n\nEach tossup must be about its assigned answer. CRITICAL: the answer word and any variant or near-homophone of it must NEVER appear anywhere in the question text — every sentence must refer to the subject as 'this person', 'this country', 'this work', 'this element', etc., and the first sentence must not reveal its namesake, word origin, or most famous fact. Save all via mcp__3roads__save_tossups_batch with setId "${setId}".`;

		jobs.push(() =>
			runLlmChat({
				prompt: tossupPrompt,
				systemPrompt: buildTossupSystemPrompt(setId, difficulty, theme, style),
				model,
				userId,
				setId,
				onCost,
			}),
		);
	}

	for (const batch of chunk(bonusAnswers, BONUSES_PER_BATCH)) {
		const answerList = batch.map(withSubject).join("\n- ");
		const bonusPrompt = `Write ${batch.length} bonuses. Each bonus's theme should relate to this answer:\n- ${answerList}\n\nEach bonus has 3 parts with different answers. The leadin must be a plain declarative statement telling players what the bonus is about (e.g. "This bonus is about Switzerland." or "Answer these questions about the water cycle.") — never a clue or teaser. Save all via mcp__3roads__save_bonuses_batch with setId "${setId}".`;

		jobs.push(() =>
			runLlmChat({
				prompt: bonusPrompt,
				systemPrompt: buildBonusSystemPrompt(setId, difficulty, theme, style),
				model,
				userId,
				setId,
				onCost,
			}),
		);
	}

	return jobs;
}

/** Error messages from settled write jobs: rejections, and runs that finished but reported failure. */
function jobErrors(results: PromiseSettledResult<unknown>[]): string[] {
	const errors: string[] = [];
	for (const r of results) {
		if (r.status === "rejected") {
			errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
		} else if (r.value && typeof r.value === "object" && "ok" in r.value && !(r.value as { ok: boolean }).ok) {
			errors.push((r.value as { error?: string }).error || "Unknown CLI error");
		}
	}
	return errors;
}

/**
 * Add more questions to an existing set, avoiding answers it already has. Infinite mode calls
 * this as the game runs. Returns the errors of any batches that failed; the rest are saved.
 */
export async function generateMore(params: {
	setId: string;
	theme: string;
	difficulty: string;
	style?: string;
	tossupCount: number;
	bonusCount: number;
	excludeAnswers: string[];
	model?: string;
	userId: string;
	onCost?: (usd: number) => void;
}): Promise<string[]> {
	const { setId } = params;
	// planAnswers already leaves out the used answers
	const { tossupAnswers, bonusAnswers, subjects } = await planAnswers(params);
	const results = await settleLimited(writeJobs({ ...params, tossupAnswers, bonusAnswers, subjects }), MAX_PARALLEL_CALLS);
	await removeDuplicateTossups(setId);
	return jobErrors(results);
}

export async function runGeneration(params: {
	setId: string;
	theme: string;
	difficulty: string;
	style?: string;
	tossupCount: number;
	bonusCount: number;
	pictureCount?: number;
	model?: string;
	/** The user whose ChatGPT plan pays for this run. */
	userId: string;
	/** Answers other packets (in this request, or earlier sets on the theme) use; this one must avoid them */
	excludeAnswers?: string[];
	/** Called once this run's answers are chosen (or planning failed), before any writing starts */
	onPlanned?: (answers: string[]) => void;
}): Promise<void> {
	const { setId, theme, difficulty, style, model, userId, excludeAnswers = [], onPlanned } = params;
	const tossupCount = Math.min(params.tossupCount, MAX_SET_QUESTIONS);
	const bonusCount = Math.min(params.bonusCount, MAX_SET_QUESTIONS);
	const pictureCount = Math.min(params.pictureCount ?? 0, tossupCount);
	// Picture questions are drawn from the tossup budget; written tossups fill the remainder
	const writtenTossupCount = Math.max(0, tossupCount - pictureCount);
	const db = getDb();
	// Total OpenRouter spend across every LLM call for this set. Stays null for ChatGPT plan
	// runs, which have no per-call price, so the set shows no cost rather than $0.
	let cost: number | null = null;
	const onCost = (usd: number) => {
		cost = (cost ?? 0) + usd;
	};

	try {
		await db.questionSet.update({
			where: { id: setId },
			data: { status: "generating" },
		});

		// Phase 1: Answer Planning (regular tossups + bonuses)
		log.info(`[${setId}] Phase 1: generating answer plan (${writtenTossupCount} written tossups, ${bonusCount} bonuses, ${pictureCount} picture)`);

		let jobs: (() => Promise<unknown>)[] = [];
		const plannedAnswers: string[] = [];

		if (writtenTossupCount > 0 || bonusCount > 0) {
			const { tossupAnswers, bonusAnswers, subjects } = await planAnswers({
				theme, difficulty, style, tossupCount: writtenTossupCount, bonusCount, excludeAnswers, model, userId, onCost,
			});
			plannedAnswers.push(...tossupAnswers, ...bonusAnswers);

			log.info(`[${setId}] Phase 1 complete: ${tossupAnswers.length} tossup answers, ${bonusAnswers.length} bonus answers`);

			// Phase 2: Parallel Question Writing, in batches
			log.info(`[${setId}] Phase 2: writing questions in batches of ${TOSSUPS_PER_BATCH} tossups / ${BONUSES_PER_BATCH} bonuses`);
			jobs = writeJobs({ setId, theme, difficulty, style, tossupAnswers, bonusAnswers, subjects, model, userId, onCost });
		}

		onPlanned?.(plannedAnswers);

		// Picture tossups go first in the queue: they retry internally and take the longest
		if (pictureCount > 0) {
			jobs.unshift(() =>
				generatePictureTossups({ setId, count: pictureCount, theme, difficulty, excludeAnswers: [...excludeAnswers, ...plannedAnswers], userId, model, onCost }),
			);
		}

		const results = await settleLimited(jobs, MAX_PARALLEL_CALLS);
		await removeDuplicateTossups(setId);

		const errors = jobErrors(results);

		if (errors.length > 0) {
			log.error(`[${setId}] Phase 2 errors: ${errors.join("; ")}`);
			await db.questionSet.update({ where: { id: setId }, data: { status: "error", cost } });
		} else {
			log.info(`[${setId}] Generation complete${cost != null ? ` — cost=$${(cost as number).toFixed(4)}` : ""}`);
			await db.questionSet.update({ where: { id: setId }, data: { status: "complete", cost } });
		}
	} catch (err) {
		onPlanned?.([]); // no-op if already called; lets the next packet start planning
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`[${setId}] Generation failed: ${msg}`);
		await db.questionSet.update({ where: { id: setId }, data: { status: "error", cost } });
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

/**
 * Generate several packets on the same request. Each packet plans its answers only after the
 * previous one has, avoiding everything already chosen (and recent sets on the same theme), so
 * the packets never share an answer; the writing itself runs in parallel.
 */
export async function runPacketGenerations(runs: Parameters<typeof runGeneration>[0][]): Promise<void> {
	if (runs.length === 0) return;
	const { theme, userId } = runs[0];
	// Earlier sets on this theme count as used too, so repeat runs keep finding new answers
	const used = await answersOnTheme(theme, userId, runs.map((r) => r.setId)).catch((err) => {
		log.warn(`Looking up earlier answers on "${theme}" failed: ${err instanceof Error ? err.message : err}`);
		return [] as string[];
	});
	if (used.length > 0) log.info(`Avoiding ${used.length} answers from earlier "${theme}" sets`);
	const running: Promise<void>[] = [];
	for (const run of runs) {
		await new Promise<void>((planned) => {
			running.push(
				runGeneration({
					...run,
					excludeAnswers: [...used],
					onPlanned: (answers) => {
						used.push(...answers);
						planned();
					},
				}).finally(planned),
			);
		});
	}
	await Promise.all(running);
}
