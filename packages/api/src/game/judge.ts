
import { createLogger } from "@3roads/shared";
import type { GameSettings } from "./types.js";
import { tidyAnswerBraces } from "../services/question-store.js";
import {
	DEFAULT_MODEL,
	DEFAULT_OPENROUTER_MODEL,
	defaultModelFor,
	isOpenRouterModel,
	runLlmChatSimple,
} from "../services/llm-chat.js";

const log = createLogger("api:game:judge");

// -- Local answer matching (fast path) --

export type Verdict = "correct" | "incorrect" | "prompt";

interface AnswerLine {
	accept: string[];
	prompt: string[];
	reject: string[];
}

/** Top-level [...] / (...) groups in an answer line, honouring nesting: "[accept (Lord) Byron]" is one group. */
function bracketGroups(text: string): string[] {
	const groups: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "[" || ch === "(") {
			if (depth === 0) start = i + 1;
			depth++;
		} else if ((ch === "]" || ch === ")") && depth > 0) {
			depth--;
			if (depth === 0) groups.push(text.slice(start, i));
		}
	}
	return groups;
}

/** "X or \"Y\"" → ["X", "Y"] */
function splitAlternatives(list: string): string[] {
	return list
		.split(/\s+or\s+/i)
		.map((alt) => alt.replace(/^["'“‘]+|["'”’]+$/g, "").trim())
		.filter(Boolean);
}

/**
 * Parse a quiz bowl answer line into its accept / prompt / reject directives.
 * e.g. "Lord Byron [accept George Gordon Byron; prompt on Byron; do not accept Gordon]"
 *   → accept ["Lord Byron", "George Gordon Byron"], prompt ["Byron"], reject ["Gordon"]
 */
function parseAnswerLine(canonical: string): AnswerLine {
	const line: AnswerLine = { accept: [], prompt: [], reject: [] };

	// Main answer is everything before the first bracket or parenthesis
	const main = canonical.match(/^([^[(]+)/)?.[1].trim();
	if (main) line.accept.push(main);

	for (const group of bracketGroups(canonical)) {
		for (const clause of group.split(/\s*;\s*/)) {
			const m = clause.match(/^(accept|or|prompt(?: on)?|do not accept|don't accept|reject)\b:?\s*(.*)$/i);
			if (!m) continue;
			const keyword = m[1].toLowerCase();
			if (keyword.startsWith("prompt")) {
				// Drop timing qualifiers like "prompt on Byron before 'Lord'" — the LLM handles that nuance
				line.prompt.push(...splitAlternatives(m[2].replace(/\s+(?:before|until|after)\b.*$/i, "")));
			} else if (keyword === "accept" || keyword === "or") {
				line.accept.push(...splitAlternatives(m[2]));
			} else {
				line.reject.push(...splitAlternatives(m[2]));
			}
		}
	}

	if (line.accept.length === 0) line.accept.push(canonical.trim());
	return line;
}

const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10 };

/** "iv" \u2192 "4" for numerals I\u2013XXXIX (regnal numbers, sequels); any other word is returned unchanged. */
function romanToArabic(word: string): string {
	if (!/^x{0,3}(ix|iv|v?i{0,3})$/.test(word) || !word) return word;
	let total = 0;
	for (let i = 0; i < word.length; i++) {
		const value = ROMAN_VALUES[word[i]];
		const next = ROMAN_VALUES[word[i + 1]] ?? 0;
		total += value < next ? -value : value;
	}
	return String(total);
}

const NUMBER_WORDS: Record<string, string> = {
	zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
	eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
	eighteen: "18", nineteen: "19", twenty: "20",
};

/**
 * Normalize an answer for comparison: lowercase, strip articles/punctuation, collapse whitespace.
 * Articles are dropped anywhere ("the girl with the pearl earring" = "Girl with a Pearl Earring"),
 * except a final "a", which is usually a letter ("Vitamin A", "Hepatitis A").
 * Roman numerals become digits ("James I" = "james 1") and a plural "s" is dropped from each word
 * ("war of the roses" = "Wars of the Roses"), and number words become digits ("World War Two" = "World War II").
 * Both sides go through this, so the folding is symmetric.
 */
function normalize(answer: string): string {
	const words = answer
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		// Hyphens and slashes separate words: "CRISPR-Cas9" is "crispr cas9", not "crisprcas9"
		.replace(/[-/]/g, " ")
		.replace(/[^a-z0-9\s]/g, "")
		.trim()
		.split(/\s+/);
	return words
		.filter((word, i) => !(word === "the" || word === "an" || (word === "a" && i < words.length - 1)))
		.map((word) => NUMBER_WORDS[word] ?? romanToArabic(word).replace(/([^s])s$/, "$1"))
		.join(" ");
}

/** Edit distance counting a swap of neighbouring letters as one edit ("napolean" ~ "napoleon"). */
function editDistance(a: string, b: string): number {
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
	for (let j = 1; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	}
	return d[a.length][b.length];
}

/**
 * Typo tolerance for one word: 1 edit from 7 letters, 2 from 10, same first letter. Shorter words
 * get none, since near-misses there are often different answers ("Monet"/"Manet", "Iran"/"Iraq");
 * those still go to the LLM judge.
 */
function typoMatch(submitted: string, form: string): boolean {
	if (submitted[0] !== form[0]) return false;
	const length = Math.max(submitted.length, form.length);
	const allowed = length >= 10 ? 2 : length >= 7 ? 1 : 0;
	return allowed > 0 && editDistance(submitted, form) <= allowed;
}

/**
 * Word-by-word stem match: each submitted word and answer word share a stem, the shorter being a
 * prefix of the longer by at most 3 letters ("incan" ~ "inca", "mongolian" ~ "mongol"), or are a
 * small typo apart ("shakespear" ~ "shakespeare").
 * Short words must match exactly so "ma" doesn't stem-match "mao".
 */
function stemMatch(submitted: string, form: string): boolean {
	const a = submitted.split(" ");
	const b = form.split(" ");
	if (a.length !== b.length) return false;
	return a.every((word, i) => {
		const [short, long] = word.length <= b[i].length ? [word, b[i]] : [b[i], word];
		return (
			short === long ||
			(short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3) ||
			typoMatch(word, b[i])
		);
	});
}

const CONJUNCTION_SPLIT = /\s+and\s+|\s*[,&]\s*/;

/** Exact matches against one accept form: normalized equality, conjunct order, or the {required} part. */
function strictMatch(submitted: string, form: string): boolean {
	const normalizedForm = normalize(form);
	if (!normalizedForm) return false;
	if (submitted === normalizedForm) return true;

	// Order-agnostic match for conjunctive answers ("spain and france" == "france and spain")
	if (CONJUNCTION_SPLIT.test(normalizedForm) || CONJUNCTION_SPLIT.test(submitted)) {
		const sortParts = (s: string) => s.split(CONJUNCTION_SPLIT).map((p) => p.trim()).filter(Boolean).sort().join(" ");
		if (sortParts(submitted) === sortParts(normalizedForm)) return true;
	}

	// Required-part markup: "{Bakerloo} line" accepts "bakerloo"
	const required = [...form.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
	return required.length > 0 && submitted === normalize(required.join(" "));
}

/**
 * Words that say what kind of thing an answer is rather than which one ("war", "river").
 * Normalized (singular) forms.
 */
const GENERIC_HEADS = new Set(
	("war battle treaty empire kingdom dynasty republic revolution rebellion revolt river lake sea ocean mountain mount island " +
		"bay gulf strait desert canal city state province county act law theorem effect principle equation constant acid " +
		"party church company university line bridge street palace cathedral castle crisis affair incident massacre movement " +
		"period era age conference council accord agreement doctrine plan system festival award prize cup opera symphony " +
		"sonata concerto galaxy nebula comet planet moon syndrome disease reaction cycle method language people tribe").split(" "),
);
/** Titles and linking words a player may wrap around an answer ("king henry 8", "battle of hastings") */
const TITLES = new Set("king queen president emperor empress saint st sir lord lady pope prince princess general dr mr m of".split(" "));
const ACRONYM_SKIP = new Set(["of", "and", "for", "in", "on", "de"]);

/** "ussr" for "Union of Soviet Socialist Republics", "uk" for "United Kingdom" */
function acronymMatch(submitted: string, normalizedForm: string): boolean {
	if (submitted.includes(" ") || submitted.length < 2) return false;
	const words = normalizedForm.split(" ");
	if (words.length < 2) return false;
	const initials = (ws: string[]) => ws.map((w) => w[0]).join("");
	return submitted === initials(words) || submitted === initials(words.filter((w) => !ACRONYM_SKIP.has(w)));
}

/** "john kennedy" for "John Fitzgerald Kennedy": first and last words match, the rest are an ordered subset. */
function middleOmittedMatch(submitted: string, normalizedForm: string): boolean {
	const a = submitted.split(" ");
	const b = normalizedForm.split(" ");
	if (a.length < 2 || a.length >= b.length) return false;
	if (!stemMatch(a[0], b[0]) || !stemMatch(a[a.length - 1], b[b.length - 1])) return false;
	let j = 1;
	for (const word of a.slice(1, -1)) {
		while (j < b.length - 1 && !stemMatch(word, b[j])) j++;
		if (j >= b.length - 1) return false;
		j++;
	}
	return true;
}

/** The answer plus only descriptive extras: "battle of hastings" for "Hastings", "river thames" for "Thames". */
function descriptorMatch(submitted: string, normalizedForm: string): boolean {
	const a = submitted.split(" ");
	const n = normalizedForm.split(" ").length;
	for (let i = 0; i + n <= a.length; i++) {
		if (!stemMatch(a.slice(i, i + n).join(" "), normalizedForm)) continue;
		const extras = [...a.slice(0, i), ...a.slice(i + n)];
		if (extras.length > 0 && extras.every((w) => GENERIC_HEADS.has(w) || TITLES.has(w))) return true;
	}
	return false;
}

/** Looser guesses at what the answer line would accept. Only tried once prompts/rejects have had their say. */
function heuristicMatch(submitted: string, form: string): boolean {
	const normalizedForm = normalize(form);
	if (!normalizedForm) return false;

	// Required-part markup is authoritative: only stem variants of the braced part
	// (e.g. "{Ely}, Cambridgeshire" rejects "cambridgeshire")
	const required = [...form.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
	// The full answer, typos and all, is fine too: it contains the braced part
	if (required.length > 0) return stemMatch(submitted, normalize(required.join(" "))) || stemMatch(submitted, normalizedForm);

	if (stemMatch(submitted, normalizedForm)) return true;
	if (acronymMatch(submitted, normalizedForm) || middleOmittedMatch(submitted, normalizedForm) || descriptorMatch(submitted, normalizedForm)) {
		return true;
	}

	// Surname match: submitted = last word of a multi-word answer (e.g. "atkinson" for "Rowan Atkinson"),
	// unless that word only says what kind of thing the answer is ("empire" for "Holy Roman Empire")
	const formWords = normalizedForm.split(" ");
	const lastWord = formWords[formWords.length - 1];
	if (formWords.length > 1 && !GENERIC_HEADS.has(lastWord) && stemMatch(submitted, lastWord)) return true;

	// Comma qualifier: "Ely, Cambridgeshire" accepts "ely". Skipped for conjunctive answers,
	// where the comma separates required parts rather than an optional qualifier.
	if (form.includes(",") && !/\s+and\s+|&/i.test(form)) {
		const head = normalize(form.split(",")[0]);
		if (head && submitted === head) return true;
	}
	return false;
}

/**
 * Fast local judge. "unsure" means we need to fall back to the LLM.
 * Order matters: exact accepts win, then explicit reject/prompt directives, then heuristics —
 * so "Lord Byron [prompt on Byron]" prompts on "byron" instead of surname-matching it.
 */
function localJudge(submitted: string, line: AnswerLine): Verdict | "unsure" {
	const normalizedSubmitted = normalize(submitted);
	if (!normalizedSubmitted) return "unsure";

	if (line.accept.some((form) => strictMatch(normalizedSubmitted, form))) return "correct";
	if (line.reject.some((form) => normalize(form) === normalizedSubmitted)) return "incorrect";
	if (line.prompt.some((form) => stemMatch(normalizedSubmitted, normalize(form)))) return "prompt";
	if (line.accept.some((form) => heuristicMatch(normalizedSubmitted, form))) return "correct";

	return "unsure";
}

/**
 * Verdict for what the local judge is unsure of when no LLM is asked: prompt when every submitted
 * word is part of a longer accepted answer ("war" for "Crimean War"), otherwise incorrect.
 */
function fallbackVerdict(submitted: string, line: AnswerLine): Verdict {
	const words = normalize(submitted).split(" ");
	const partial = line.accept.some((form) => {
		// Only the required part counts when there is one: "cambridgeshire" is no step towards "{Ely}, Cambridgeshire"
		const required = [...form.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(" ");
		const formWords = normalize(required || form).split(" ");
		return formWords.length > words.length && words.every((w) => formWords.some((f) => stemMatch(w, f)));
	});
	return partial ? "prompt" : "incorrect";
}

// -- Public API --

export async function judgeAnswer(
	submittedAnswer: string,
	canonicalAnswer: string,
	questionText: string,
	/** Without aiJudge, answers the local matcher is unsure of are prompted or ruled incorrect, never sent to an LLM */
	settings: Pick<GameSettings, "strictness" | "aiJudge">,
	/**
	 * The answering player's user ID. Their own ChatGPT plan pays for LLM judging, never
	 * another player's; without one, OpenRouter judges (when the server has a key), and
	 * failing that ambiguous answers are judged incorrect.
	 */
	userId?: string,
	/** Called with the dollar cost of an OpenRouter judging call */
	onCost?: (usd: number) => void,
): Promise<{ verdict: Verdict }> {
	if (!submittedAnswer.trim()) {
		return { verdict: "incorrect" };
	}

	// Fast path: exact matches, explicit directives, and conservative heuristics
	// Questions saved before date qualifiers were moved out of the braces still have them inside
	canonicalAnswer = tidyAnswerBraces(canonicalAnswer);
	const line = parseAnswerLine(canonicalAnswer);
	const localVerdict = localJudge(submittedAnswer, line);
	if (localVerdict !== "unsure") {
		log.info(`judge [local] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${localVerdict}`);
		return { verdict: localVerdict };
	}

	// Slow path: fall back to LLM for ambiguous cases
	const model = settings.aiJudge ? await defaultModelFor(userId, CHATGPT_JUDGE_MODEL) : null;
	if (!model) {
		const verdict = fallbackVerdict(submittedAnswer, line);
		const reason = settings.aiJudge ? "no ChatGPT plan or OpenRouter key to judge with" : "AI judge off";
		log.info(`judge [local] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" unsure, ${reason}, verdict=${verdict}`);
		return { verdict };
	}
	const judgeModel = isOpenRouterModel(model) ? OPENROUTER_JUDGE_MODEL : model;
	// Bracketed notes are stripped from the canonical answer and their directives passed as separate lines instead

	const canonicalForLlm = canonicalAnswer.replace(/\s*\[[^\]]*\]/g, "").trim();
	const alternates = line.accept.filter((form) => form !== canonicalForLlm);
	log.info(`judge [llm] — local unsure, falling back to LLM for submitted="${submittedAnswer}" canonical="${canonicalForLlm}"`);

	const systemPrompt = "You are a quiz bowl answer judge. Respond with ONLY \"correct\", \"incorrect\", or \"prompt\".";
	const userPrompt = [
		`The canonical answer is: ${canonicalForLlm}`,
		...(alternates.length > 0 ? [`Also acceptable: ${alternates.join("; ")}`] : []),
		...(line.prompt.length > 0 ? [`Prompt on: ${line.prompt.join("; ")}`] : []),
		...(line.reject.length > 0 ? [`Do not accept: ${line.reject.join("; ")}`] : []),
		...(canonicalForLlm.includes("{")
			? ["Text in {braces} is the part the player must give; everything outside the braces is optional. The braces mark the minimum, not an exact string: still accept equivalent forms of the braced text, and treat a qualifier inside the braces like \"of England\" as optional if it was clearly braced by mistake."]
			: []),
		`The player submitted: ${submittedAnswer}`,
		`The question was: ${questionText.slice(0, 500)}`,
		`Leniency: ${settings.strictness}/10. At 1, require an exact match. At 10, accept any answer that demonstrates knowledge of the correct answer. At the default of 7, accept reasonable variations like missing articles, minor misspellings, partial but clearly correct answers, adjective/demonym forms (e.g. "Italian" for "Italy", "Incan" for "Inca"), surnames alone for person answers (e.g. "Atkinson" is correct for "Rowan Atkinson"), and the commonly used short form of a compound name (e.g. "CRISPR" for "CRISPR-Cas9", "Hubble" for "Hubble Space Telescope"). Qualifiers in the canonical answer are optional: a place given with its region or country (e.g. "Ely" is correct for "Ely, Cambridgeshire"), or a title or disambiguation after a comma. Arabic and Roman numerals are equivalent (e.g. \"James 1\" is correct for \"James I\"), and singular/plural differences are fine (e.g. \"War of the Roses\" is correct for \"Wars of the Roses\").`,
		`Respond "prompt" when the submission matches a "Prompt on" form, or is on the right track but not specific enough to be judged (e.g. "war" for "Crimean War"). The player will then get another chance to answer.`,
	].join("\n");

	try {
		const result = await runLlmChatSimple({
			userId,
			model: judgeModel,
			systemPrompt,
			prompt: userPrompt,
			signal: AbortSignal.timeout(15_000),
			onCost,
		});
		// Word-boundary checks: "**Incorrect**" or "The answer is incorrect." must not read as correct
		const text = result.toLowerCase();
		const verdict: Verdict = /\bprompt\b/.test(text)
			? "prompt"
			: /\bcorrect\b/.test(text) && !/\b(incorrect|not correct)\b/.test(text)
				? "correct"
				: "incorrect";
		log.info(`judge [llm ${judgeModel}] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${verdict}`);
		return { verdict };
	} catch (err) {
		log.error(`judge [llm] — error: ${err instanceof Error ? err.message : err}, treating as incorrect`);
		return { verdict: "incorrect" };
	}
}

// -- LLM backend --

const CHATGPT_JUDGE_MODEL = process.env.OPENAI_JUDGE_MODEL || DEFAULT_MODEL;
const OPENROUTER_JUDGE_MODEL = process.env.OPENROUTER_JUDGE_MODEL || DEFAULT_OPENROUTER_MODEL;
