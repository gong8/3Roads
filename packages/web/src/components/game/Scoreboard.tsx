interface PlayerScore {
	id: string;
	name: string;
	score: number;
	bonusScore: number;
	powers: number;
	tens: number;
	negs: number;
	isModerator?: boolean;
	team?: "a" | "b";
}

interface Props {
	players: PlayerScore[];
	currentPlayerId: string | null;
	teamMode?: boolean;
	compact?: boolean;
}

export function Scoreboard({ players, currentPlayerId, teamMode = false, compact = false }: Props) {
	const sorted = [...players].sort((a, b) => b.score - a.score);

	if (teamMode) {
		const teamA = sorted.filter((p) => p.team === "a");
		const teamB = sorted.filter((p) => p.team === "b");
		const scoreA = teamA.reduce((s, p) => s + p.score, 0);
		const scoreB = teamB.reduce((s, p) => s + p.score, 0);

		return (
			<div className="border border-black p-3 mb-3">
				<div className="flex justify-between mb-2 text-xs">
					<span>team A: {scoreA}</span>
					<span>team B: {scoreB}</span>
				</div>
				{!compact && <TeamTable players={teamA} label="A" currentPlayerId={currentPlayerId} />}
				{!compact && <TeamTable players={teamB} label="B" currentPlayerId={currentPlayerId} />}
			</div>
		);
	}

	return (
		<div className={compact ? "" : "border border-black p-3 mb-3"}>
			<table className="w-full text-xs">
				<thead>
					<tr className="text-left border-b border-black">
						<th className="py-1">name</th>
						<th className="py-1 text-right">total</th>
						{!compact && <th className="py-1 text-right">tossup</th>}
						{!compact && <th className="py-1 text-right">bonus</th>}
						{!compact && <th className="py-1 text-right">15</th>}
						{!compact && <th className="py-1 text-right">10</th>}
						{!compact && <th className="py-1 text-right">-5</th>}
					</tr>
				</thead>
				<tbody>
					{sorted.map((p) => (
						<tr key={p.id} className={p.id === currentPlayerId ? "font-bold" : ""}>
							<td className="py-1">{p.name}{p.isModerator ? " *" : ""}</td>
							<td className="py-1 text-right">{p.score}</td>
							{!compact && <td className="py-1 text-right">{p.score - p.bonusScore}</td>}
							{!compact && <td className="py-1 text-right">{p.bonusScore}</td>}
							{!compact && <td className="py-1 text-right">{p.powers}</td>}
							{!compact && <td className="py-1 text-right">{p.tens}</td>}
							{!compact && <td className="py-1 text-right">{p.negs}</td>}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function TeamTable({ players, label, currentPlayerId }: { players: PlayerScore[]; label: string; currentPlayerId: string | null }) {
	return (
		<div className="mb-2">
			<div className="text-xs text-gray-500 mb-1">team {label}</div>
			<table className="w-full text-xs">
				<tbody>
					{players.map((p) => (
						<tr key={p.id} className={p.id === currentPlayerId ? "font-bold" : ""}>
							<td className="py-0.5">{p.name}{p.isModerator ? " *" : ""}</td>
							<td className="py-0.5 text-right">{p.score}</td>
							<td className="py-0.5 text-right text-gray-500">{p.score - p.bonusScore}T/{p.bonusScore}B</td>
							<td className="py-0.5 text-right">{p.powers}P</td>
							<td className="py-0.5 text-right">{p.tens}T</td>
							<td className="py-0.5 text-right">{p.negs}N</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
