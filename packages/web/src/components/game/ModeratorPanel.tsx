import { useState } from "react";

interface Props {
	phase: string;
	onSkip: () => void;
	onNext: () => void;
	onEndGame: () => void;
	onKick: (playerId: string) => void;
	onUpdateSettings: (settings: { strictness?: number; msPerWord?: number }) => void;
	players: { id: string; name: string; isModerator: boolean }[];
	ttsEnabled?: boolean;
}

export function ModeratorPanel({ phase, onSkip, onNext, onEndGame, onKick, onUpdateSettings, players, ttsEnabled }: Props) {
	const kickable = players.filter((p) => !p.isModerator);
	const [leniency, setLeniency] = useState(7);
	const [readingSpeed, setReadingSpeed] = useState(300);

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
			<div className="mt-2 flex flex-col gap-2">
				<div>
					<label className="text-xs text-gray-500 block mb-1">
						leniency: {leniency}/10
					</label>
					<input
						type="range"
						min={1}
						max={10}
						step={1}
						value={leniency}
						onChange={(e) => {
							const v = Number(e.target.value);
							setLeniency(v);
							onUpdateSettings({ strictness: v });
						}}
						className="w-48"
					/>
				</div>
				{!ttsEnabled && (
				<div>
					<label className="text-xs text-gray-500 block mb-1">
						reading speed: {(1000 / readingSpeed).toFixed(1)} words/s
					</label>
					<input
						type="range"
						min={100}
						max={500}
						step={50}
						value={600 - readingSpeed}
						onChange={(e) => {
							const v = 600 - Number(e.target.value);
							setReadingSpeed(v);
							onUpdateSettings({ msPerWord: v });
						}}
						className="w-48"
					/>
					<div className="text-xs text-gray-400 flex justify-between w-48">
						<span>slow</span>
						<span>fast</span>
					</div>
				</div>
			)}
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
