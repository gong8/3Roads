import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSets } from "../hooks/useSets";

type Tab = "create" | "join";

export function Play() {
	const navigate = useNavigate();
	const [tab, setTab] = useState<Tab>("create");
	const [name, setName] = useState("");
	const [roomCode, setRoomCode] = useState("");
	const [selectedSetId, setSelectedSetId] = useState("");
	const [mode, setMode] = useState<"ffa" | "teams">("ffa");
	const [ttsEnabled, setTtsEnabled] = useState(false);
	const [leniency, setLeniency] = useState(7);
	const [wordsPerSec, setWordsPerSec] = useState(4.5);
	const [error, setError] = useState<string | null>(null);

	const { data: sets } = useSets();

	const handleCreate = () => {
		if (!name.trim()) { setError("enter a name"); return; }
		if (!selectedSetId) { setError("select a question set"); return; }
		const msPerWord = Math.round(1000 / wordsPerSec);
		navigate("/play/new", {
			state: { action: "create", questionSetId: selectedSetId, playerName: name.trim(), mode, ttsEnabled, leniency, readingSpeed: msPerWord },
		});
	};

	const handleJoin = () => {
		if (!name.trim()) { setError("enter a name"); return; }
		if (!roomCode.trim()) { setError("enter a room code"); return; }
		navigate(`/play/${roomCode.trim().toUpperCase()}`, {
			state: { action: "join", playerName: name.trim() },
		});
	};

	return (
		<div>
			<div className="flex gap-4 mb-4">
				<button type="button" onClick={() => setTab("create")} className={tab === "create" ? "underline" : "text-gray-500"}>
					create room
				</button>
				<button type="button" onClick={() => setTab("join")} className={tab === "join" ? "underline" : "text-gray-500"}>
					join room
				</button>
			</div>

			<div className="mb-3">
				<label className="block text-xs text-gray-500 mb-1">display name</label>
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="border border-black px-2 py-1 text-sm w-full max-w-xs"
					placeholder="your name"
				/>
			</div>

			{tab === "create" && (
				<>
					<div className="mb-3">
						<label className="block text-xs text-gray-500 mb-1">question set</label>
						<select
							value={selectedSetId}
							onChange={(e) => setSelectedSetId(e.target.value)}
							className="border border-black px-2 py-1 text-sm w-full max-w-xs"
						>
							<option value="">select...</option>
							{sets?.map((s) => (
								<option key={s.id} value={s.id}>
									{s.name} ({s.tossupCount}T / {s.bonusCount}B)
								</option>
							))}
						</select>
					</div>
					<div className="mb-3">
						<label className="block text-xs text-gray-500 mb-1">mode</label>
						<select
							value={mode}
							onChange={(e) => setMode(e.target.value as "ffa" | "teams")}
							className="border border-black px-2 py-1 text-sm w-full max-w-xs"
						>
							<option value="ffa">free for all</option>
							<option value="teams">teams (2)</option>
						</select>
					</div>
					<div className="mb-3">
						<label className="text-xs text-gray-500 flex items-center gap-2">
							<input
								type="checkbox"
								checked={ttsEnabled}
								onChange={(e) => setTtsEnabled(e.target.checked)}
							/>
							text-to-speech
						</label>
					</div>
					<div className="mb-3">
						<label className="text-xs text-gray-500 block mb-1">
							leniency: {leniency}/10
						</label>
						<input
							type="range"
							min={1}
							max={10}
							step={1}
							value={leniency}
							onChange={(e) => setLeniency(Number(e.target.value))}
							className="w-48"
						/>
					</div>
					<div className="mb-3">
						<label className="text-xs text-gray-500 block mb-1">
							reading speed: {wordsPerSec.toFixed(1)} words/s
						</label>
						<input
							type="range"
							min={1.0}
							max={8.0}
							step={0.1}
							value={wordsPerSec}
							onChange={(e) => setWordsPerSec(Number(e.target.value))}
							className="w-48"
						/>
						<div className="text-xs text-gray-400 flex justify-between w-48">
							<span>slow</span>
							<span>fast</span>
						</div>
					</div>
					<button type="button" onClick={handleCreate} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
						create room
					</button>
				</>
			)}

			{tab === "join" && (
				<>
					<div className="mb-3">
						<label className="block text-xs text-gray-500 mb-1">room code</label>
						<input
							type="text"
							value={roomCode}
							onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
							className="border border-black px-2 py-1 text-sm w-full max-w-xs uppercase"
							placeholder="ABCD"
							maxLength={4}
						/>
					</div>
					<button type="button" onClick={handleJoin} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
						join room
					</button>
				</>
			)}

			{error && <div className="mt-3 text-red-700 text-xs">{error}</div>}
		</div>
	);
}
