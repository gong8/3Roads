/**
 * Show a date qualifier out of the required part: "{Chilean coup of 1973}" shows as
 * "{Chilean coup} of 1973", since players needn't say the year.
 */
function tidyAnswerBraces(answer: string): string {
	return answer.replace(/\{([^{}]*?)\s+((?:of|in)\s+\d{3,4}|\(\d{3,4}\)|\d{3,4})\}/g, "{$1} $2");
}

/** Renders an answer line, underlining the {braced} part a player must give: "{Bakerloo} line". */
export function AnswerText({ answer }: { answer: string }) {
	return (
		<>
			{tidyAnswerBraces(answer).split(/(\{[^}]*\})/).map((part, i) =>
				part.startsWith("{") && part.endsWith("}") ? (
					<u key={i} className="font-bold">{part.slice(1, -1)}</u>
				) : (
					part
				),
			)}
		</>
	);
}
