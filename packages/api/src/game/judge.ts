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
 * Roman numerals become digits ("James I" = "james 1") and a plural "s" is dropped from each word
 * ("war of the roses" = "Wars of the Roses"). Both sides go through this, so the folding is symmetric.
 */
function normalize(answer: string): string {
	return answer
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.trim()
		.replace(/^(a|an|the)\s+/i, "")
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.map((word) => romanToArabic(word).replace(/([^s])s$/, "$1"))
		.join(" ");
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

		// Required-part markup: "{Bakerloo} line" accepts "bakerloo". When present it is authoritative,
		// so the guessing heuristics below are skipped (e.g. "{Ely}, Cambridgeshire" rejects "cambridgeshire").
		const required = [...form.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
		if (required.length > 0) {
			if (normalizedSubmitted === normalize(required.join(" "))) return "correct";
			continue;
		}

		// Surname match: submitted = last word of a multi-word answer (e.g. "atkinson" for "Rowan Atkinson")
		const formWords = normalizedForm.split(" ");
		if (formWords.length > 1 && normalizedSubmitted === formWords[formWords.length - 1]) return "correct";

		// Comma qualifier: "Ely, Cambridgeshire" accepts "ely". Skipped for conjunctive answers,
		// where the comma separates required parts rather than an optional qualifier.
		if (form.includes(",") && !/\s+and\s+|&/i.test(form)) {
			const head = normalize(form.split(",")[0]);
			if (head && normalizedSubmitted === head) return "correct";
		}
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
		...(canonicalForLlm.includes("{")
			? ["Text in {braces} is the part the player must give; everything outside the braces is optional. The braces mark the minimum, not an exact string: still accept equivalent forms of the braced text, and treat a qualifier inside the braces like \"of England\" as optional if it was clearly braced by mistake."]
			: []),
		`The player submitted: ${submittedAnswer}`,
		`The question was: ${questionText.slice(0, 500)}`,
		`Leniency: ${strictness}/10. At 1, require an exact match. At 10, accept any answer that demonstrates knowledge of the correct answer. At the default of 7, accept reasonable variations like missing articles, minor misspellings, partial but clearly correct answers, adjective/demonym forms (e.g. "Italian" for "Italy"), and surnames alone for person answers (e.g. "Atkinson" is correct for "Rowan Atkinson"). Qualifiers in the canonical answer are optional: a place given with its region or country (e.g. "Ely" is correct for "Ely, Cambridgeshire"), or a title or disambiguation after a comma. Arabic and Roman numerals are equivalent (e.g. \"James 1\" is correct for \"James I\"), and singular/plural differences are fine (e.g. \"War of the Roses\" is correct for \"Wars of the Roses\").`,
	].join("\n");

	try {
		const result = await fetchJudge(systemPrompt, userPrompt);
		// Word-boundary checks: "**Incorrect**" or "The answer is incorrect." must not read as correct
		const verdict = result.toLowerCase();
		const correct = /\bcorrect\b/.test(verdict) && !/\b(incorrect|not correct)\b/.test(verdict);
		log.info(`judge [llm] — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${correct ? "correct" : "incorrect"}`);
		return { correct };
	} catch (err) {
		log.error(`judge [llm] — error: ${err instanceof Error ? err.message : err}, treating as incorrect`);
		return { correct: false };
	}
}

// -- LLM backend --

const OPENROUTER_JUDGE_MODEL =
	process.env.OPENROUTER_JUDGE_MODEL || process.env.OPENROUTER_MODEL || "meta/muse-spark-1.3-contributor";

log.info(`Judge LLM backend: OpenRouter (model=${OPENROUTER_JUDGE_MODEL})`);

async function fetchJudge(systemPrompt: string, userPrompt: string): Promise<string> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

	const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"X-Title": "3Roads",
		},
		body: JSON.stringify({
			model: OPENROUTER_JUDGE_MODEL,
			max_tokens: 16,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
		}),
		signal: AbortSignal.timeout(10000),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 200)}`);
	}

	const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return data.choices?.[0]?.message?.content ?? "";
}
