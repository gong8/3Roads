interface Player {
	id: string;
	name: string;
	team?: "a" | "b";
	isModerator: boolean;
}

interface Props {
	players: Player[];
	isModerator: boolean;
	onSetTeam: (playerId: string, team: "a" | "b") => void;
}

export function TeamAssignment({ players, isModerator, onSetTeam }: Props) {
	const teamA = players.filter((p) => p.team === "a");
	const teamB = players.filter((p) => p.team === "b");

	return (
		<div className="border border-black p-3 mb-3">
			<div className="text-xs text-gray-500 mb-2">teams</div>
			<div className="grid grid-cols-2 gap-4">
				<div>
					<div className="text-xs font-bold mb-1">team A</div>
					{teamA.map((p) => (
						<div key={p.id} className="text-xs flex justify-between">
							<span>{p.name}{p.isModerator ? " *" : ""}</span>
							{isModerator && (
								<button type="button" onClick={() => onSetTeam(p.id, "b")} className="underline text-gray-500">
									-&gt; B
								</button>
							)}
						</div>
					))}
				</div>
				<div>
					<div className="text-xs font-bold mb-1">team B</div>
					{teamB.map((p) => (
						<div key={p.id} className="text-xs flex justify-between">
							{isModerator && (
								<button type="button" onClick={() => onSetTeam(p.id, "a")} className="underline text-gray-500">
									A &lt;-
								</button>
							)}
							<span>{p.name}{p.isModerator ? " *" : ""}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
