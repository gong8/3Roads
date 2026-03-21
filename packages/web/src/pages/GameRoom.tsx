import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useGameAudio } from "../hooks/useGameAudio";
import { useGameRoom } from "../hooks/useGameRoom";
import { AnswerInput } from "../components/game/AnswerInput";
import { BonusReader } from "../components/game/BonusReader";
import { BuzzButton } from "../components/game/BuzzButton";
import { ModeratorPanel } from "../components/game/ModeratorPanel";
import { Scoreboard } from "../components/game/Scoreboard";
import { TeamAssignment } from "../components/game/TeamAssignment";
import { TossupReader } from "../components/game/TossupReader";

interface CreateState {
	action: "create";
	questionSetId: string;
	playerName: string;
	mode: "ffa" | "teams";
	ttsEnabled?: boolean;
	leniency?: number;
	readingSpeed?: number;
}

interface JoinState {
	action: "join";
	playerName: string;
}

type LocationState = CreateState | JoinState | null;

export function GameRoom() {
	const { roomCode } = useParams<{ roomCode: string }>();
	const location = useLocation();
	const navigate = useNavigate();
	const initRef = useRef(false);
	const {
		state,
		createRoom,
		joinRoom,
		buzz,
		submitAnswer,
		submitBonusAnswer,
		startGame,
		nextQuestion,
		skip,
		endGame,
		kickPlayer,
		setTeam,
		updateSettings,
		disconnect,
	} = useGameRoom();

	const locationState = location.state as LocationState;

	useGameAudio(state);

	// Initialize connection on mount
	useEffect(() => {
		if (initRef.current) return;
		if (!locationState) {
			navigate("/play", { replace: true });
			return;
		}
		initRef.current = true;

		if (locationState.action === "create") {
			createRoom(locationState.questionSetId, locationState.playerName, locationState.mode, locationState.ttsEnabled ?? false);
			if (locationState.leniency != null || locationState.readingSpeed != null) {
				updateSettings({
					...(locationState.leniency != null && { strictness: locationState.leniency }),
					...(locationState.readingSpeed != null && { msPerWord: locationState.readingSpeed }),
				});
			}
		} else if (locationState.action === "join" && roomCode) {
			joinRoom(roomCode, locationState.playerName);
		}

		return () => {
			initRef.current = false;
			disconnect();
		};
	}, [locationState, roomCode, createRoom, joinRoom, navigate, disconnect, updateSettings]);

	// When room is created, update URL to actual room code
	useEffect(() => {
		if (state.roomCode && roomCode === "new") {
			navigate(`/play/${state.roomCode}`, { replace: true, state: locationState });
		}
	}, [state.roomCode, roomCode, navigate, locationState]);

	// Handle kicked
	useEffect(() => {
		if (state.kicked) {
			navigate("/play", { replace: true });
		}
	}, [state.kicked, navigate]);

	// Keyboard shortcuts
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if (e.code === "Space" && state.phase === "reading_tossup") {
				e.preventDefault();
				buzz();
			}
		},
		[state.phase, buzz],
	);

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	const isModerator = useMemo(() => {
		return state.players.find((p) => p.id === state.playerId)?.isModerator ?? false;
	}, [state.players, state.playerId]);

	const myPlayer = state.players.find((p) => p.id === state.playerId);
	const isTeamMode = state.players.some((p) => p.team != null);
	const ttsEnabled = locationState?.action === "create" ? (locationState.ttsEnabled ?? false) : false;

	const canBuzz = state.phase === "reading_tossup" && !state.neggedPlayerIds.has(state.playerId ?? "");
	const isMyBuzz = state.awaitAnswer?.playerId === state.playerId;

	const canAnswerBonus = (() => {
		if (state.phase !== "bonus_answering" || !state.bonus || !state.awaitBonusAnswer) return false;
		if (state.awaitBonusAnswer.controllingPlayerId === state.playerId) return true;
		const controlling = state.players.find((p) => p.id === state.awaitBonusAnswer?.controllingPlayerId);
		return controlling?.team != null && controlling.team === myPlayer?.team;
	})();

	const displayCode = state.roomCode || roomCode;

	if (!state.connected && !state.playerId) {
		return <div className="text-xs text-gray-500">connecting...</div>;
	}

	return (
		<div>
			<div className="flex justify-between items-baseline mb-4">
				<div className="text-xs text-gray-500">room: <span className="text-black font-bold">{displayCode}</span></div>
				<div className="text-xs text-gray-500">{state.phase}</div>
			</div>

			{/* Lobby */}
			{state.phase === "lobby" && (
				<div>
					<div className="mb-3 text-xs text-gray-500">
						share code: <span className="text-black font-bold text-lg">{displayCode}</span>
					</div>
					<Scoreboard players={state.players} currentPlayerId={state.playerId} teamMode={isTeamMode} />
					{isTeamMode && (
						<TeamAssignment players={state.players} isModerator={isModerator} onSetTeam={setTeam} />
					)}
					{isModerator && (
						<ModeratorPanel
							phase={state.phase}
							onSkip={skip}
							onNext={nextQuestion}
							onEndGame={endGame}
							onKick={kickPlayer}
							onUpdateSettings={updateSettings}
							players={state.players}
							ttsEnabled={ttsEnabled}
						/>
					)}
					{isModerator && state.players.length >= 1 && (
						<button type="button" onClick={startGame} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
							start game
						</button>
					)}
				</div>
			)}

			{/* TTS pregeneration progress */}
			{state.ttsProgress && (
				<div className="mb-4">
					<div className="text-xs text-gray-500 mb-1">
						generating audio... {state.ttsProgress.current}/{state.ttsProgress.total}
						{state.ttsProgress.etaMs != null && state.ttsProgress.etaMs > 0 && (
							<> — {Math.ceil(state.ttsProgress.etaMs / 60000)}m {Math.ceil((state.ttsProgress.etaMs % 60000) / 1000)}s left</>
						)}
					</div>
					<div className="w-full max-w-xs h-1 bg-gray-200">
						<div
							className="h-1 bg-black transition-all"
							style={{ width: `${(state.ttsProgress.current / state.ttsProgress.total) * 100}%` }}
						/>
					</div>
				</div>
			)}

			{/* Reading Tossup / Awaiting Answer / Judging */}
			{(state.phase === "reading_tossup" || state.phase === "awaiting_answer" || state.phase === "judging") && state.tossup && (
				<div>
					<TossupReader
						words={state.tossup.words}
						isPowerZone={state.tossup.isPowerZone}
						category={state.tossup.category}
						subcategory={state.tossup.subcategory}
						questionNumber={state.tossup.questionNumber}
						totalQuestions={state.tossup.totalQuestions}
					/>

					{state.phase === "reading_tossup" && (
						<BuzzButton onBuzz={buzz} disabled={!canBuzz} />
					)}

					{state.buzzedPlayer && (
						<div className="text-xs mt-2">{state.buzzedPlayer.name} buzzed!</div>
					)}

					{state.phase === "awaiting_answer" && isMyBuzz && state.awaitAnswer && (
						<div className="mt-2">
							<AnswerInput onSubmit={submitAnswer} timeMs={state.awaitAnswer.timeMs} />
						</div>
					)}

					{state.phase === "awaiting_answer" && !isMyBuzz && state.awaitAnswer && (
						<div className="mt-2 text-xs text-gray-500">waiting for {state.awaitAnswer.playerName} to answer...</div>
					)}

					{state.phase === "judging" && (
						<div className="mt-2 text-xs text-gray-500">judging...</div>
					)}

					{state.lastResult && (
						<div className={`mt-2 text-xs ${state.lastResult.correct ? "text-green-700" : "text-red-700"}`}>
							{state.lastResult.playerName}: "{state.lastResult.answer}" — {state.lastResult.correct ? `correct (+${state.lastResult.points})` : `incorrect (${state.lastResult.points})`}
						</div>
					)}

					<div className="mt-3">
						<Scoreboard players={state.players} currentPlayerId={state.playerId} compact teamMode={isTeamMode} />
					</div>
				</div>
			)}

			{/* Bonus */}
			{(state.phase === "reading_bonus" || state.phase === "bonus_answering") && state.bonus && (
				<div>
					<BonusReader
						leadin={state.bonus.leadin}
						controllingPlayerName={state.bonus.controllingPlayerName}
						category={state.bonus.category}
						subcategory={state.bonus.subcategory}
						words={state.bonus.words}
						currentPart={state.bonus.currentPart}
						partResults={state.bonus.partResults}
						totalPoints={state.bonus.totalPoints}
					/>

					{state.phase === "bonus_answering" && canAnswerBonus && state.awaitBonusAnswer && (
						<AnswerInput onSubmit={submitBonusAnswer} timeMs={state.awaitBonusAnswer.timeMs} label="bonus answer" />
					)}

					{state.phase === "bonus_answering" && !canAnswerBonus && (
						<div className="text-xs text-gray-500 mt-2">waiting for answer...</div>
					)}

					<div className="mt-3">
						<Scoreboard players={state.players} currentPlayerId={state.playerId} compact teamMode={isTeamMode} />
					</div>
				</div>
			)}

			{/* Dead tossup message */}
			{state.deadAnswer && !["reading_tossup", "reading_bonus", "bonus_answering"].includes(state.phase) && (
				<div className="text-xs text-gray-500 mb-2">
					dead tossup — answer: <span className="font-bold text-black">{state.deadAnswer}</span>
				</div>
			)}

			{/* Between questions */}
			{state.phase === "between_questions" && (
				<div>
					{state.lastResult && (
						<div className={`mb-2 text-xs ${state.lastResult.correct ? "text-green-700" : "text-red-700"}`}>
							{state.lastResult.playerName}: "{state.lastResult.answer}" — {state.lastResult.correct ? `correct (+${state.lastResult.points})` : `incorrect (${state.lastResult.points})`}
						</div>
					)}
					{state.bonus?.totalPoints != null && (
						<div className="mb-2 text-xs text-gray-500">bonus total: {state.bonus.totalPoints}/30</div>
					)}
					<Scoreboard players={state.players} currentPlayerId={state.playerId} teamMode={isTeamMode} />
					{isModerator && (
						<button type="button" onClick={nextQuestion} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
							next question
						</button>
					)}
				</div>
			)}

			{/* Game over */}
			{state.phase === "game_over" && (
				<div>
					<div className="mb-3 font-bold">game over</div>
					{state.gameOverPlayers && (
						<Scoreboard
							players={state.gameOverPlayers.map((p) => ({ ...p, isModerator: false }))}
							currentPlayerId={state.playerId}
							teamMode={state.gameOverPlayers.some((p) => p.team != null)}
						/>
					)}
					<button type="button" onClick={() => navigate("/play")} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
						back to lobby
					</button>
				</div>
			)}

			{/* Moderator controls */}
			{isModerator && state.phase !== "lobby" && state.phase !== "game_over" && (
				<div className="mt-4">
					<ModeratorPanel
						phase={state.phase}
						onSkip={skip}
						onNext={nextQuestion}
						onEndGame={endGame}
						onKick={kickPlayer}
						onUpdateSettings={updateSettings}
						players={state.players}
					/>
				</div>
			)}

			{state.error && <div className="mt-3 text-red-700 text-xs">{state.error}</div>}
		</div>
	);
}
