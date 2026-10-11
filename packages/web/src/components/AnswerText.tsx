/** Renders an answer line, underlining the {braced} part a player must give: "{Bakerloo} line". */
export function AnswerText({ answer }: { answer: string }) {
	return (
		<>
			{answer.split(/(\{[^}]*\})/).map((part, i) =>
				part.startsWith("{") && part.endsWith("}") ? (
					<u key={i} className="font-bold">{part.slice(1, -1)}</u>
				) : (
					part
				),
			)}
		</>
	);
}
