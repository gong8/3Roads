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
	const [isOpen, setIsOpen] = useState(false);

	return (
		<>
			{!isOpen && (
				<button 
					type="button" 
					onClick={() => setIsOpen(true)}
					className="fixed right-0 top-[15%] bg-white border border-r-0 border-black px-2 py-3 text-xs z-50 shadow-sm hover:bg-gray-50 rounded-l cursor-pointer opacity-80 hover:opacity-100"
					style={{ writingMode: 'vertical-rl' }}
				>
					host controls
				</button>
			)}
			
			{isOpen && (
				<div className="fixed right-0 top-0 bottom-0 w-72 bg-white border-l border-black p-4 z-50 shadow-2xl overflow-y-auto flex flex-col">
					<div className="flex justify-between items-center mb-6">
						<div className="font-bold">host controls</div>
						<button type="button" onClick={() => setIsOpen(false)} className="text-xl leading-none hover:text-gray-500">&times;</button>
					</div>

					<div className="flex flex-col gap-2 mb-6 border-b border-gray-100 pb-4">
						<div className="text-xs text-gray-500 mb-1">game flow</div>
						<div className="flex flex-wrap gap-2">
							{(phase === "reading_tossup" || phase === "awaiting_answer" || phase === "reading_bonus" || phase === "bonus_answering" || phase === "judging") && (
								<button type="button" onClick={onSkip} className="border border-black px-3 py-1 text-xs hover:bg-black hover:text-white">
									skip
								</button>
							)}
							{phase === "between_questions" && (
								<button type="button" onClick={onNext} className="border border-black px-3 py-1 text-xs hover:bg-black hover:text-white">
									next
								</button>
							)}
							<button type="button" onClick={onEndGame} className="border border-black px-3 py-1 text-xs hover:bg-black hover:text-white">
								end game
							</button>
						</div>
					</div>

					<div className="flex flex-col gap-4 mb-6 border-b border-gray-100 pb-4">
						<div className="text-xs text-gray-500">settings</div>
						<div>
							<label className="text-xs text-gray-600 block mb-1">
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
								className="w-full"
							/>
						</div>
						
						{!ttsEnabled && (
						<div>
							<label className="text-xs text-gray-600 block mb-1">
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
								className="w-full"
							/>
							<div className="text-[10px] text-gray-400 flex justify-between w-full mt-1">
								<span>slow</span>
								<span>fast</span>
							</div>
						</div>
					)}
					</div>

					{kickable.length > 0 && (
						<div className="mt-auto pt-4">
							<div className="text-xs text-red-700 mb-2">danger zone</div>
							<div className="flex flex-col gap-2">
								{kickable.map((p) => (
									<button key={p.id} type="button" onClick={() => onKick(p.id)} className="border border-red-200 text-red-700 px-2 py-1 flex justify-between text-xs hover:bg-red-50 w-full text-left">
										<span>kick {p.name}</span>
										<span>&times;</span>
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</>
	);
}
