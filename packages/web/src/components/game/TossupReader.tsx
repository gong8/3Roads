interface Props {
	words: string[];
	isPowerZone: boolean;
	category: string;
	subcategory: string;
	questionNumber: number;
	totalQuestions: number;
}

export function TossupReader({ words, isPowerZone, category, subcategory, questionNumber, totalQuestions }: Props) {
	return (
		<div className="border border-black p-3 mb-3">
			<div className="flex justify-between text-xs text-gray-500 mb-2">
				<span>{category} / {subcategory}</span>
				<span>{questionNumber} / {totalQuestions}</span>
			</div>
			<p className="whitespace-pre-wrap min-h-[3rem]">
				{words.map((word, i) => {
					const cleanWord = word.replace(/\(\*\)/g, "");
					return (
					<span key={i}>
						{i > 0 ? " " : ""}{cleanWord}
					</span>
					);
				})}
				<span className="animate-pulse">|</span>
			</p>
		</div>
	);
}
