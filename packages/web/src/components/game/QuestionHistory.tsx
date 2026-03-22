import { useState, useMemo } from "react";
import type { HistoryEntry } from "../../hooks/useGameRoom";

function renderTossupText(text: string, buzzes: NonNullable<HistoryEntry["buzzes"]>) {
	const words = text.split(" ");
	
	let powerWordIndex = -1;
	for (let i = 0; i < words.length; i++) {
		if (words[i].includes("(*)")) {
			powerWordIndex = i;
			break;
		}
	}

	const elements: React.ReactNode[] = [];
	for (let i = 0; i < words.length; i++) {
		const wordBuzzes = buzzes.filter(b => b.buzzWordIndex === i);
		for (const b of wordBuzzes) {
			elements.push(
				<span key={`buzz-${b.playerName}-${i}`} className="inline-block mx-0.5 text-xs text-white bg-black px-1 rounded-sm font-normal">
					{b.playerName} ({b.correct ? '✓' : '✗'})
				</span>
			);
		}
		if (i > 0) elements.push(" ");
		
		const isPower = powerWordIndex !== -1 && i <= powerWordIndex;
		elements.push(
			<span key={i} className={isPower ? "font-bold" : ""}>
				{words[i]}
			</span>
		);
	}
	const endBuzzes = buzzes.filter(b => b.buzzWordIndex >= words.length);
	for (const b of endBuzzes) {
		elements.push(
			<span key={`buzz-${b.playerName}-end`} className="inline-block mx-0.5 text-xs text-white bg-black px-1 rounded-sm font-normal">
				{b.playerName} ({b.correct ? '✓' : '✗'})
			</span>
		);
	}

	return <div className="text-gray-800 leading-relaxed mb-1">{elements}</div>;
}

export function QuestionHistory({ history }: { history: HistoryEntry[] }) {
	const [expanded, setExpanded] = useState(true);

	if (history.length === 0) return null;

	return (
		<div className="mt-4 border-t border-gray-200 pt-3">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="text-xs text-gray-500 hover:text-black flex items-center gap-1"
			>
				<span className="inline-block transition-transform" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
				history ({history.length})
			</button>

			{expanded && (
				<div className="mt-2 space-y-2">
					{[...history].reverse().map((entry, i) => (
						<div key={history.length - 1 - i} className="text-xs border border-gray-100 p-2">
							<div className="flex justify-between items-baseline mb-1 border-b border-gray-100 pb-1">
								<span className="text-gray-400">
									Q{entry.questionNumber} · {entry.type === "tossup" ? "TU" : "B"} · {entry.category}
									{entry.subcategory !== entry.category && ` / ${entry.subcategory}`}
								</span>
								{entry.type === "tossup" && entry.dead && (
									<span className="text-gray-400">dead</span>
								)}
								{entry.type === "bonus" && (
									<span className="text-gray-600">{entry.totalBonusPoints}/30</span>
								)}
							</div>

							{entry.type === "tossup" && (
								<>
									{entry.questionText && renderTossupText(entry.questionText, entry.buzzes || [])}
									<div>
										<span className="text-gray-400">answer: </span>
										<span className="font-bold">{entry.answer}</span>
									</div>
									{entry.buzzes && entry.buzzes.length > 0 && (
										<div className="mt-1 space-y-0.5">
											{entry.buzzes.map((b, i) => (
												<div key={i} className="text-gray-500 text-xs">
													{b.playerName} answered "{b.answer}" <span className={b.correct ? "text-green-700" : "text-red-700"}>{b.correct ? `(+${b.points})` : `(${b.points})`}</span>
												</div>
											))}
										</div>
									)}
								</>
							)}

							{entry.type === "bonus" && entry.partResults && (
								<div className="space-y-1">
									{entry.controllingPlayer && (
										<div className="text-gray-400 mb-1">{entry.controllingPlayer}'s bonus</div>
									)}
									{entry.partResults.map((pr) => (
										<div key={pr.partNumber} className="flex flex-col gap-0.5 border-l-2 border-gray-200 pl-2">
											{pr.partText && <div className="text-gray-800 leading-relaxed mb-0.5">{pr.partText}</div>}
											<div className="flex gap-2 text-[11px]">
												<span className={pr.correct ? "text-green-700 font-bold" : "text-red-700 font-bold"}>
													{pr.correct ? `✓ 10` : `✗ 0`}
												</span>
												<div className="flex flex-col">
													<span><span className="text-gray-400">answer: </span><span className="font-bold">{pr.answer}</span></span>
													{!pr.correct && pr.submittedAnswer && (
														<span className="text-gray-400"> — said "{pr.submittedAnswer}"</span>
													)}
												</div>
											</div>
										</div>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
