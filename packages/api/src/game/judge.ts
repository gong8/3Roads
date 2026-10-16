import { createLogger } from "@3roads/shared";
import { DEFAULT_MODEL, runLlmChatSimple } from "../services/llm-chat.js";

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

/**
 * Normalize an answer for comparison: lowercase, strip articles/punctuation, collapse whitespace.
 * Articles are dropped anywhere ("the girl with the pearl earring" = "Girl with a Pearl Earring"),
 * except a final "a", which is usually a letter ("Vitamin A", "Hepatitis A").
 * Roman numerals become digits ("James I" = "james 1") and a plural "s" is dropped from each word
 * ("war of the roses" = "Wars of the Roses"). Both sides go through this, so the folding is symmetric.
 */
function normalize(answer: string): string {
	const words = answer
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9\s]/g, "")
		.trim()
		.split(/\s+/);
	return words
		.filter((word, i) => !(word === "the" || word === "an" || (word === "a" && i < words.length - 1)))
		.map((word) => romanToArabic(word).replace(/([^s])s$/, "$1"))
		.join(" ");
}

/**
 * Word-by-word stem match: each submitted word and answer word share a stem, the shorter being a
 * prefix of the longer by at most 3 letters ("incan" ~ "inca", "mongolian" ~ "mongol").
 * Short words must match exactly so "ma" doesn't stem-match "mao".
 */
function stemMatch(submitted: string, form: string): boolean {
	const a = submitted.split(" ");
	const b = form.split(" ");
	if (a.length !== b.length) return false;
	return a.every((word, i) => {
		const [short, long] = word.length <= b[i].length ? [word, b[i]] : [b[i], word];
		return short === long || (short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3);
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

/** Looser guesses at what the answer line would accept. Only tried once prompts/rejects have had their say. */
function heuristicMatch(submitted: string, form: string): boolean {
	const normalizedForm = normalize(form);
	if (!normalizedForm) return false;

	// Required-part markup is authoritative: only stem variants of the braced part
	// (e.g. "{Ely}, Cambridgeshire" rejects "cambridgeshire")
	const required = [...form.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
	if (required.length > 0) return stemMatch(submitted, normalize(required.join(" ")));

	if (stemMatch(submitted, normalizedForm)) return true;

	// Surname match: submitted = last word of a multi-word answer (e.g. "atkinson" for "Rowan Atkinson")
	const formWords = normalizedForm.split(" ");
	if (formWords.length > 1 && submitted === formWords[formWords.length - 1]) return true;

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
	if (line.prompt.some((form) => normalize(form) === normalizedSubmitted)) return "prompt";
	if (line.accept.some((form) => heuristicMatch(normalizedSubmitted, form))) return "correct";

	return "unsure";
}

// -- Public API --

export async function judgeAnswer(
	submittedAnswer: string,
	canonicalAnswer: string,
	questionText: string,
	strictness: number,
	/**
	 * The answering player's user ID. Their own ChatGPT plan pays for LLM judging, never
	 * another player's; without a connected plan, ambiguous answers are judged incorrect.
	 */
	userId?: string,
): Promise<{ verdict: Verdict }> {
	if (!submittedAnswer.trim()) {
		return { verdict: "incorrect" };
	}

	// Fast path: exact matches, explicit directives, and conservative heuristics
	const line = parseAnswerLine(canonicalAnswer);
	const localVerdict = localJudge(submittedAnswer, line);
	if (localVerdict !== "unsure") {
		log.info(`judge [local] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${localVerdict}`);
		return { verdict: localVerdict };
	}

	// Slow path: fall back to LLM for ambiguous cases
	if (!userId) {
		log.info(`judge [local] — submitted="${submittedAnswer}" unsure and the player is not identified, verdict=incorrect`);
		return { verdict: "incorrect" };
	}
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
		`Leniency: ${strictness}/10. At 1, require an exact match. At 10, accept any answer that demonstrates knowledge of the correct answer. At the default of 7, accept reasonable variations like missing articles, minor misspellings, partial but clearly correct answers, adjective/demonym forms (e.g. "Italian" for "Italy", "Incan" for "Inca"), and surnames alone for person answers (e.g. "Atkinson" is correct for "Rowan Atkinson"). Qualifiers in the canonical answer are optional: a place given with its region or country (e.g. "Ely" is correct for "Ely, Cambridgeshire"), or a title or disambiguation after a comma. Arabic and Roman numerals are equivalent (e.g. \"James 1\" is correct for \"James I\"), and singular/plural differences are fine (e.g. \"War of the Roses\" is correct for \"Wars of the Roses\").`,
		`Respond "prompt" when the submission matches a "Prompt on" form, or is on the right track but not specific enough to be judged (e.g. "war" for "Crimean War"). The player will then get another chance to answer.`,
	].join("\n");

	try {
		const result = await fetchJudge(userId, systemPrompt, userPrompt);
		// Word-boundary checks: "**Incorrect**" or "The answer is incorrect." must not read as correct
		const text = result.toLowerCase();
		const verdict: Verdict = /\bprompt\b/.test(text)
			? "prompt"
			: /\bcorrect\b/.test(text) && !/\b(incorrect|not correct)\b/.test(text)
				? "correct"
				: "incorrect";
		log.info(`judge [llm] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${verdict}`);
		return { verdict };
	} catch (err) {
		log.error(`judge [llm] — error: ${err instanceof Error ? err.message : err}, treating as incorrect`);
		return { verdict: "incorrect" };
	}
}

// -- LLM backend --

const JUDGE_MODEL = process.env.OPENAI_JUDGE_MODEL || DEFAULT_MODEL;

function fetchJudge(userId: string, systemPrompt: string, userPrompt: string): Promise<string> {
	return runLlmChatSimple({
		userId,
		model: JUDGE_MODEL,
		systemPrompt,
		prompt: userPrompt,
		signal: AbortSignal.timeout(15_000),
	});
}
