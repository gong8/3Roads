interface PartResult {
	partNumber: number;
	correct: boolean;
	answer: string;
	submittedAnswer: string;
	points: number;
}

interface Props {
	leadin: string;
	controllingPlayerName: string;
	category: string;
	subcategory: string;
	currentPart: { partNumber: number; text: string; value: number } | null;
	partResults: PartResult[];
	totalPoints: number | null;
}

export function BonusReader({ leadin, controllingPlayerName, category, subcategory, currentPart, partResults, totalPoints }: Props) {
	return (
		<div className="border border-black p-3 mb-3">
			<div className="flex justify-between text-xs text-gray-500 mb-2">
				<span>{category} / {subcategory}</span>
				<span>bonus for {controllingPlayerName}</span>
			</div>
			<p className="mb-3">{leadin}</p>

			{partResults.map((r) => (
				<div key={r.partNumber} className="ml-4 mb-2 text-xs">
					<span className={r.correct ? "text-green-700" : "text-red-700"}>
						[{r.points}] {r.correct ? "correct" : "incorrect"}
					</span>
					{!r.correct && <span className="text-gray-500"> — answer: {r.answer}</span>}
				</div>
			))}

			{currentPart && (
				<div className="ml-4 mb-2">
					<p>[{currentPart.value}] {currentPart.text}</p>
				</div>
			)}

			{totalPoints != null && (
				<div className="mt-2 text-xs text-gray-500">bonus total: {totalPoints}/30</div>
			)}
		</div>
	);
}
