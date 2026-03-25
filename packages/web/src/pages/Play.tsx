import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useSets } from "../hooks/useSets";
import { apiGet } from "../lib/api";

const ADJECTIVES = [
	"amber", "ancient", "arctic", "autumn", "azure", "bold", "brave", "bright", "bronze", "calm",
	"candid", "cardinal", "casual", "clever", "coastal", "cobalt", "cosmic", "crisp", "crimson", "curious",
	"daring", "dark", "dawnlit", "deft", "dense", "desert", "distant", "dusk", "dusty", "eager",
	"early", "electric", "ember", "emerald", "epic", "feral", "fierce", "fiery", "fleet", "foggy",
	"forest", "frosted", "gallant", "gilded", "glacial", "golden", "grand", "grave", "green", "grim",
	"haunted", "hollow", "humble", "hungry", "icy", "idle", "indigo", "iron", "jade", "jagged",
	"keen", "kind", "lanky", "large", "late", "lavender", "lean", "light", "lofty", "lone",
	"loud", "loyal", "lunar", "lush", "marble", "mellow", "mighty", "misty", "modest", "mossy",
	"murky", "mystic", "neon", "nimble", "noble", "nocturnal", "odd", "onyx", "open", "pale",
	"patient", "pebbled", "pensive", "phantom", "plain", "polar", "primal", "proud", "quiet", "rapid",
	"raven", "red", "regal", "remote", "restless", "rocky", "roving", "rugged", "russet", "rustic",
	"sage", "sandy", "sapphire", "savage", "scarlet", "serene", "shadowed", "shaggy", "sharp", "silent",
	"silver", "sleek", "slim", "slow", "small", "smoky", "snowy", "solar", "solemn", "spare",
	"spectral", "speedy", "stark", "steady", "steep", "stony", "stormy", "strange", "sturdy", "subtle",
	"sunlit", "swift", "tall", "tawny", "thorny", "tidal", "timber", "timid", "tiny", "tireless",
	"tough", "tranquil", "twilight", "umber", "vast", "velvet", "verdant", "vibrant", "vigilant", "violet",
	"wandering", "wary", "weathered", "wild", "windy", "wise", "wiry", "worn", "zealous", "zesty",
];

const ANIMALS = [
	"albatross", "alligator", "alpaca", "antelope", "armadillo", "badger", "bat", "bear", "beaver", "bison",
	"boar", "bobcat", "buffalo", "bull", "capybara", "caracal", "cassowary", "cheetah", "chinchilla", "condor",
	"cormorant", "cougar", "coyote", "crane", "crow", "dingo", "dolphin", "dormouse", "eagle", "echidna",
	"eel", "egret", "elk", "falcon", "ferret", "finch", "flamingo", "fox", "frog", "gazelle",
	"gecko", "gerbil", "gibbon", "gopher", "gorilla", "grackle", "grouse", "guanaco", "gull", "hawk",
	"hedgehog", "heron", "hippo", "hornbill", "horse", "hyena", "ibis", "iguana", "impala", "jackal",
	"jaguar", "jay", "jellyfish", "kestrel", "kingfisher", "kite", "kiwi", "koala", "komodo", "kookaburra",
	"lemur", "leopard", "lion", "lizard", "llama", "lobster", "lynx", "macaw", "marmot", "meerkat",
	"mink", "moose", "moth", "mule", "narwhal", "newt", "nightjar", "ocelot", "okapi", "osprey",
	"otter", "owl", "panda", "panther", "parrot", "pelican", "penguin", "peregrine", "pheasant", "pika",
	"piranha", "platypus", "porcupine", "puma", "python", "quail", "quokka", "rabbit", "raccoon", "raven",
	"reindeer", "rhino", "roadrunner", "salamander", "seahorse", "seal", "serval", "shark", "skunk", "sloth",
	"snail", "snake", "sparrow", "squid", "squirrel", "starling", "stork", "sturgeon", "swift", "tapir",
	"teal", "termite", "tiger", "toad", "tortoise", "toucan", "viper", "vole", "vulture", "walrus",
	"warthog", "wasp", "weasel", "whale", "wildcat", "wolf", "wolverine", "wombat", "woodpecker", "yak",
];

function randomDefaultName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
	return `${adj}-${animal}`;
}

type Tab = "create" | "join";
type PacketSource = "my-sets" | "all-packets";

interface QbPacketData {
	name: string;
	tossups: { id: string; question: string; answer: string; powerMarkIndex: null; category: string; subcategory: string; difficulty: string }[];
	bonuses: { id: string; leadin: string; category: string; subcategory: string; difficulty: string; parts: { partNum: number; text: string; answer: string; value: number }[] }[];
}

export function Play() {
	const navigate = useNavigate();
	const [tab, setTab] = useState<Tab>("create");
	const [name, setName] = useState(() => randomDefaultName());
	const [roomCode, setRoomCode] = useState("");
	const [selectedSetId, setSelectedSetId] = useState("");
	const [mode, setMode] = useState<"ffa" | "teams">("ffa");
	const [ttsEnabled, setTtsEnabled] = useState(false);
	const [includeBonuses, setIncludeBonuses] = useState(true);
	const [leniency, setLeniency] = useState(7);
	const [wordsPerSec, setWordsPerSec] = useState(4.5);
	const [error, setError] = useState<string | null>(null);

	// All Packets (QB Reader) state
	const [packetSource, setPacketSource] = useState<PacketSource>("my-sets");
	const [qbSearch, setQbSearch] = useState("");
	const [qbSelectedSet, setQbSelectedSet] = useState("");
	const [qbPacketNumber, setQbPacketNumber] = useState(1);
	const [qbSearchOpen, setQbSearchOpen] = useState(false);
	const searchRef = useRef<HTMLDivElement>(null);

	const { data: sets } = useSets();

	// Fetch QB Reader set list when "all packets" tab is active
	const { data: qbSetsData, isLoading: qbSetsLoading, isError: qbSetsError } = useQuery({
		queryKey: ["qb-sets"],
		queryFn: () => apiGet<{ sets: string[] }>("/qbreader/sets"),
		enabled: packetSource === "all-packets",
		staleTime: 5 * 60_000,
	});

	// Fetch num-packets when a set is selected
	const { data: qbNumPacketsData, isLoading: qbNumPacketsLoading } = useQuery({
		queryKey: ["qb-num-packets", qbSelectedSet],
		queryFn: () => apiGet<{ numPackets: number }>(`/qbreader/num-packets?setName=${encodeURIComponent(qbSelectedSet)}`),
		enabled: !!qbSelectedSet && packetSource === "all-packets",
		staleTime: 10 * 60_000,
	});

	const qbAllSets = qbSetsData?.sets ?? [];
	const qbNumPackets = qbNumPacketsData?.numPackets ?? null;

	const qbFilteredSets = qbSearch.trim()
		? qbAllSets.filter((s) => s.toLowerCase().includes(qbSearch.trim().toLowerCase())).slice(0, 12)
		: [];

	// Pick a random local set once the list loads
	useEffect(() => {
		if (sets && sets.length > 0 && !selectedSetId) {
			setSelectedSetId(sets[Math.floor(Math.random() * sets.length)].id);
		}
	}, [sets, selectedSetId]);

	// Clamp packet number when numPackets changes
	useEffect(() => {
		if (qbNumPackets !== null && qbPacketNumber > qbNumPackets) {
			setQbPacketNumber(qbNumPackets);
		}
	}, [qbNumPackets, qbPacketNumber]);

	// Close search dropdown on outside click
	useEffect(() => {
		function handle(e: MouseEvent) {
			if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
				setQbSearchOpen(false);
			}
		}
		document.addEventListener("mousedown", handle);
		return () => document.removeEventListener("mousedown", handle);
	}, []);

	const selectedSet = sets?.find((s) => s.id === selectedSetId);
	const setHasBonuses = (selectedSet?.bonusCount ?? 0) > 0;

	const handleCreate = async () => {
		if (!name.trim()) { setError("enter a name"); return; }
		const msPerWord = Math.round(1000 / wordsPerSec);

		if (packetSource === "my-sets") {
			if (!selectedSetId) { setError("select a question set"); return; }
			navigate("/play/new", {
				state: { action: "create", questionSetId: selectedSetId, playerName: name.trim(), mode, ttsEnabled, includeBonuses: includeBonuses && setHasBonuses, leniency, readingSpeed: msPerWord },
			});
		} else {
			// All Packets: fetch the packet now, then navigate with the data
			if (!qbSelectedSet) { setError("select a tournament set"); return; }
			setError(null);

			let packet: QbPacketData;
			try {
				packet = await apiGet<QbPacketData>(`/qbreader/packet?setName=${encodeURIComponent(qbSelectedSet)}&packetNumber=${qbPacketNumber}`);
			} catch {
				setError("failed to fetch packet — check your connection and try again");
				return;
			}

			if (!packet.tossups || packet.tossups.length === 0) {
				setError("this packet has no tossups");
				return;
			}

			navigate("/play/new", {
				state: {
					action: "create",
					playerName: name.trim(),
					mode,
					ttsEnabled,
					includeBonuses,
					leniency,
					readingSpeed: msPerWord,
					externalPacket: packet,
				},
			});
		}
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
					{/* Packet source toggle */}
					<div className="mb-3">
						<label className="block text-xs text-gray-500 mb-1">question source</label>
						<div className="flex gap-3">
							<button
								type="button"
								onClick={() => setPacketSource("my-sets")}
								className={`text-sm border px-3 py-0.5 ${packetSource === "my-sets" ? "border-black bg-black text-white" : "border-gray-300 text-gray-500"}`}
							>
								my sets
							</button>
							<button
								type="button"
								onClick={() => setPacketSource("all-packets")}
								className={`text-sm border px-3 py-0.5 ${packetSource === "all-packets" ? "border-black bg-black text-white" : "border-gray-300 text-gray-500"}`}
							>
								all packets
							</button>
						</div>
					</div>

					{packetSource === "my-sets" && (
						<div className="mb-3">
							<label className="block text-xs text-gray-500 mb-1">question set</label>
							<select
								value={selectedSetId}
								onChange={(e) => setSelectedSetId(e.target.value)}
								className="border border-black px-2 py-1 text-sm w-full max-w-xs"
							>
								<option value="">random</option>
								{sets?.map((s) => (
									<option key={s.id} value={s.id}>
										{s.name} ({s.tossupCount}T / {s.bonusCount}B)
									</option>
								))}
							</select>
						</div>
					)}

					{packetSource === "all-packets" && (
						<div className="mb-3">
							<label className="block text-xs text-gray-500 mb-1">tournament</label>

							{/* Set search */}
							<div ref={searchRef} className="relative max-w-xs mb-2">
								<input
									type="text"
									value={qbSearch}
									onChange={(e) => {
										setQbSearch(e.target.value);
										setQbSearchOpen(true);
									}}
									onFocus={() => setQbSearchOpen(true)}
									className="border border-black px-2 py-1 text-sm w-full"
									placeholder="search tournaments…"
								/>

								{qbSetsLoading && (
									<div className="text-xs text-gray-400 mt-1">loading tournament list…</div>
								)}
								{qbSetsError && (
									<div className="text-xs text-red-600 mt-1">could not load tournament list</div>
								)}

								{/* Dropdown results */}
								{qbSearchOpen && qbFilteredSets.length > 0 && (
									<div className="absolute z-10 top-full left-0 right-0 border border-black bg-white shadow-sm max-h-48 overflow-y-auto">
										{qbFilteredSets.map((s) => (
											<button
												key={s}
												type="button"
												className="block w-full text-left text-sm px-2 py-1 hover:bg-gray-100 truncate"
												onClick={() => {
													setQbSelectedSet(s);
													setQbSearch(s);
													setQbPacketNumber(1);
													setQbSearchOpen(false);
												}}
											>
												{s}
											</button>
										))}
									</div>
								)}
								{qbSearchOpen && qbSearch.trim() && qbFilteredSets.length === 0 && !qbSetsLoading && (
									<div className="absolute z-10 top-full left-0 right-0 border border-black bg-white px-2 py-1 text-sm text-gray-400">
										no matches
									</div>
								)}
							</div>

							{/* Packet number picker */}
							{qbSelectedSet && (
								<div className="flex items-center gap-2">
									<label className="text-xs text-gray-500">packet</label>
									{qbNumPacketsLoading ? (
										<span className="text-xs text-gray-400">loading…</span>
									) : (
										<>
											<button
												type="button"
												className="border border-black w-5 h-5 text-xs flex items-center justify-center hover:bg-black hover:text-white disabled:opacity-30"
												onClick={() => setQbPacketNumber((n) => Math.max(1, n - 1))}
												disabled={qbPacketNumber <= 1}
											>
												−
											</button>
											<input
												type="number"
												min={1}
												max={qbNumPackets ?? 99}
												value={qbPacketNumber}
												onChange={(e) => {
													const v = Number(e.target.value);
													if (v >= 1 && (qbNumPackets === null || v <= qbNumPackets)) {
														setQbPacketNumber(v);
													}
												}}
												className="border border-black px-1 py-0.5 text-sm w-12 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
											/>
											<button
												type="button"
												className="border border-black w-5 h-5 text-xs flex items-center justify-center hover:bg-black hover:text-white disabled:opacity-30"
												onClick={() => setQbPacketNumber((n) => (qbNumPackets ? Math.min(qbNumPackets, n + 1) : n + 1))}
												disabled={qbNumPackets !== null && qbPacketNumber >= qbNumPackets}
											>
												+
											</button>
											{qbNumPackets !== null && (
												<span className="text-xs text-gray-400">of {qbNumPackets}</span>
											)}
										</>
									)}
								</div>
							)}
						</div>
					)}

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
								checked={
									packetSource === "all-packets"
										? includeBonuses
										: includeBonuses && setHasBonuses
								}
								onChange={(e) => setIncludeBonuses(e.target.checked)}
								disabled={packetSource === "my-sets" && !setHasBonuses}
							/>
							read bonuses
							{packetSource === "my-sets" && selectedSetId && !setHasBonuses && (
								<span className="text-gray-400">(this set has no bonuses)</span>
							)}
						</label>
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
