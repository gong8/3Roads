interface PartResult {
	partNumber: number;
	correct: boolean;
	answer: string;
	submittedAnswer: string;
	points: number;
	partText?: string;
}

interface Props {
	leadin: string;
	controllingPlayerName: string;
	category: string;
	subcategory: string;
	words: string[];
	currentPart: { partNumber: number; value: number } | null;
	partResults: PartResult[];
	totalPoints: number | null;
}

export function BonusReader({ leadin, controllingPlayerName, category, subcategory, words, currentPart, partResults, totalPoints }: Props) {
	return (
		<div className="border border-black p-3 mb-3">
			<div className="flex justify-between text-xs text-gray-500 mb-2">
				<span>{category} / {subcategory}</span>
				<span>bonus for {controllingPlayerName}</span>
			</div>

			{/* Leadin text shown either as completed (if on part > 0) or word-by-word */}
			<div className="mb-4 text-sm leading-relaxed text-gray-800">
				{(!currentPart && words.length > 0) ? (
					words.join(" ")
				) : (
					leadin
				)}
			</div>

			{partResults.map((r, idx) => (
				<div key={r.partNumber} className="ml-4 mb-4 text-xs border-l-2 border-gray-200 pl-3">
					{r.partText && <div className="mb-1 text-sm text-gray-800">{r.partText}</div>}
					<div className="flex items-center gap-2">
						<span className={`font-bold ${r.correct ? "text-green-700" : "text-red-700"}`}>
							[{r.points}] {r.correct ? "correct" : "incorrect"}
						</span>
						{!r.correct && <span className="text-gray-500"> — answer: {r.answer}</span>}
					</div>
				</div>
			))}

			{currentPart && (
				<div className="ml-4 mb-2 text-sm leading-relaxed">
					<span className="font-bold text-gray-500 mr-2">[{currentPart.value}]</span>
					<span>{words.join(" ")}</span>
				</div>
			)}

			{totalPoints != null && (
				<div className="mt-2 text-xs text-gray-500">bonus total: {totalPoints}/30</div>
			)}
		</div>
	);
}
