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

interface QuestionGroup {
	questionNumber: number;
	tossup?: HistoryEntry;
	bonus?: HistoryEntry;
}

export function QuestionHistory({ history }: { history: HistoryEntry[] }) {
	const [expanded, setExpanded] = useState(true);

	const groups = useMemo(() => {
		const map = new Map<number, QuestionGroup>();
		for (const entry of history) {
			const existing = map.get(entry.questionNumber);
			if (existing) {
				if (entry.type === "tossup") existing.tossup = entry;
				else existing.bonus = entry;
			} else {
				map.set(entry.questionNumber, {
					questionNumber: entry.questionNumber,
					tossup: entry.type === "tossup" ? entry : undefined,
					bonus: entry.type === "bonus" ? entry : undefined,
				});
			}
		}
		return [...map.values()].reverse();
	}, [history]);

	if (history.length === 0) return null;

	return (
		<div className="mt-4 border-t border-gray-200 pt-3">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="text-xs text-gray-500 hover:text-black flex items-center gap-1"
			>
				<span className="inline-block transition-transform" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
				history ({groups.length})
			</button>

			{expanded && (
				<div className="mt-2 space-y-2">
					{groups.map((group) => (
						<div key={group.questionNumber} className="text-xs border border-gray-100 p-2">
							<div className="flex justify-between items-baseline mb-1 border-b border-gray-100 pb-1">
								<span className="text-gray-400">
									Q{group.questionNumber} · {group.tossup?.category ?? group.bonus?.category}
									{(group.tossup?.subcategory ?? group.bonus?.subcategory) !== (group.tossup?.category ?? group.bonus?.category) &&
										` / ${group.tossup?.subcategory ?? group.bonus?.subcategory}`}
								</span>
								<div className="flex gap-2">
									{group.tossup?.dead && (
										<span className="text-gray-400">dead</span>
									)}
									{group.bonus && (
										<span className="text-gray-600">{group.bonus.totalBonusPoints}/{group.bonus.maxBonusPoints ?? 30}</span>
									)}
								</div>
							</div>

							{group.tossup && (
								<>
									{group.tossup.questionText && renderTossupText(group.tossup.questionText, group.tossup.buzzes || [])}
									<div>
										<span className="text-gray-400">answer: </span>
										<span className="font-bold">{group.tossup.answer}</span>
									</div>
									{group.tossup.buzzes && group.tossup.buzzes.length > 0 && (
										<div className="mt-1 space-y-0.5">
											{group.tossup.buzzes.map((b, i) => (
												<div key={i} className="text-gray-500 text-xs">
													{b.playerName} answered "{b.answer}" <span className={b.correct ? "text-green-700" : "text-red-700"}>{b.correct ? `(+${b.points})` : `(${b.points})`}</span>
												</div>
											))}
										</div>
									)}
								</>
							)}

							{group.bonus && group.bonus.partResults && (
								<div className={`space-y-1 ${group.tossup ? "mt-2 pt-2 border-t border-gray-100" : ""}`}>
									{group.bonus.controllingPlayer && (
										<div className="text-gray-400 mb-1">{group.bonus.controllingPlayer}'s bonus</div>
									)}
									{group.bonus.partResults.map((pr) => (
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
