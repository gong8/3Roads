interface Props {
	phase: string;
	onSkip: () => void;
	onNext: () => void;
	onEndGame: () => void;
	onKick: (playerId: string) => void;
	players: { id: string; name: string; isModerator: boolean }[];
}

export function ModeratorPanel({ phase, onSkip, onNext, onEndGame, onKick, players }: Props) {
	const kickable = players.filter((p) => !p.isModerator);

	return (
		<div className="border border-black p-3 mb-3">
			<div className="text-xs text-gray-500 mb-2">host controls</div>
			<div className="flex flex-wrap gap-2">
				{(phase === "reading_tossup" || phase === "awaiting_answer" || phase === "reading_bonus" || phase === "bonus_answering" || phase === "judging") && (
					<button type="button" onClick={onSkip} className="border border-black px-2 py-1 text-xs hover:bg-black hover:text-white">
						skip
					</button>
				)}
				{phase === "between_questions" && (
					<button type="button" onClick={onNext} className="border border-black px-2 py-1 text-xs hover:bg-black hover:text-white">
						next
					</button>
				)}
				<button type="button" onClick={onEndGame} className="border border-black px-2 py-1 text-xs hover:bg-black hover:text-white">
					end game
				</button>
			</div>
			{kickable.length > 0 && (
				<div className="mt-2">
					<div className="text-xs text-gray-500 mb-1">kick player</div>
					<div className="flex flex-wrap gap-1">
						{kickable.map((p) => (
							<button key={p.id} type="button" onClick={() => onKick(p.id)} className="border border-black px-2 py-0.5 text-xs hover:bg-black hover:text-white">
								{p.name}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
