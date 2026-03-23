import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useGameAudio } from "../hooks/useGameAudio";
import { useGameRoom } from "../hooks/useGameRoom";
import { AnswerInput } from "../components/game/AnswerInput";
import { BonusReader } from "../components/game/BonusReader";
import { BuzzButton } from "../components/game/BuzzButton";
import { ModeratorPanel } from "../components/game/ModeratorPanel";
import { QuestionHistory } from "../components/game/QuestionHistory";
import { Scoreboard } from "../components/game/Scoreboard";
import { TeamAssignment } from "../components/game/TeamAssignment";
import { TossupReader } from "../components/game/TossupReader";
import { useState } from "react";

interface CreateState {
	action: "create";
	questionSetId: string;
	playerName: string;
	mode: "ffa" | "teams";
	ttsEnabled?: boolean;
	includeBonuses?: boolean;
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
		pause,
		resume,
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
		sendAudioReady,
		cancelTts,
		sendTyping,
		disconnect,
	} = useGameRoom();

	const locationState = location.state as LocationState;

	useGameAudio(state, sendAudioReady);

	// Initialize connection on mount (runs once; URL change from /new to /ABCD must not re-run)
	useEffect(() => {
		if (initRef.current) return;
		if (!locationState) {
			navigate("/play", { replace: true });
			return;
		}
		initRef.current = true;

		if (locationState.action === "create") {
			createRoom(locationState.questionSetId, locationState.playerName, locationState.mode, {
				ttsEnabled: locationState.ttsEnabled,
				includeBonuses: locationState.includeBonuses,
				leniency: locationState.leniency,
				msPerWord: locationState.readingSpeed
			});
		} else if (locationState.action === "join" && roomCode) {
			joinRoom(roomCode, locationState.playerName);
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Disconnect on unmount only
	useEffect(() => {
		return () => {
			initRef.current = false;
			disconnect();
		};
	}, [disconnect]);

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

	const canBuzzBonus = (() => {
		if (state.phase !== "reading_bonus" || !state.bonus || !state.bonus.currentPart) return false;
		const controlling = state.players.find((p) => p.name === state.bonus?.controllingPlayerName);
		if (!controlling || !myPlayer) return false;
		if (controlling.id === state.playerId) return true;
		return controlling.team != null && controlling.team === myPlayer.team;
	})();

	// Keyboard shortcuts
	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if (e.code === "Space" && state.phase !== "lobby") {
				e.preventDefault();
				if (state.phase === "reading_tossup" || canBuzzBonus) buzz();
			}
			if (e.key === "n" && state.phase === "between_questions") {
				e.preventDefault();
				nextQuestion();
			}
			if (e.key === "s" && isModerator && state.phase === "lobby") {
				e.preventDefault();
				startGame();
			}
			if (e.key === "p") {
				e.preventDefault();
				if (state.phase === "paused") resume();
				else pause();
			}
		},
		[state.phase, canBuzzBonus, buzz, isModerator, nextQuestion, startGame, pause, resume],
	);

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleKeyDown]);

	const [showScoreboard, setShowScoreboard] = useState(true);

	const displayCode = state.roomCode || roomCode;

	if (!state.connected && !state.playerId) {
		return <div className="text-xs text-gray-500">connecting...</div>;
	}

	return (
		<>
			{/* Hideable Left Scoreboard */}
			{!showScoreboard && (
				<button
					type="button"
					onClick={() => setShowScoreboard(true)}
					className="fixed left-0 top-[15%] bg-white border border-l-0 border-black px-2 py-3 text-xs z-40 shadow-sm hover:bg-gray-50 rounded-r cursor-pointer opacity-80 hover:opacity-100"
					style={{ writingMode: 'vertical-rl' }}
				>
					scoreboard
				</button>
			)}

			<div className={`fixed left-0 top-0 bottom-0 w-72 bg-white border-r border-black p-4 z-40 shadow-2xl overflow-y-auto flex flex-col transition-transform ${showScoreboard ? "translate-x-0" : "-translate-x-full"}`}>
				<div className="flex justify-between items-center mb-6">
					<div className="font-bold">scoreboard</div>
					<button type="button" onClick={() => setShowScoreboard(false)} className="text-xl leading-none hover:text-gray-500">&times;</button>
				</div>
				<Scoreboard 
					players={state.phase === "game_over" && state.gameOverPlayers 
						? state.gameOverPlayers.map((p) => ({ ...p, isModerator: false }))
						: state.players} 
					currentPlayerId={state.playerId} 
					teamMode={isTeamMode || (state.phase === "game_over" && (state.gameOverPlayers?.some(p => p.team != null) ?? false))} 
				/>
				{state.phase === "lobby" && isTeamMode && (
					<div className="mt-4">
						<TeamAssignment players={state.players} isModerator={isModerator} onSetTeam={setTeam} />
					</div>
				)}
			</div>

			{/* Main Content Column */}
			<div className="max-w-3xl mx-auto w-full pt-8 px-4">
				<div className="flex justify-between items-baseline mb-4">
					{state.phase === "lobby" ? (
						<div className="text-xs text-gray-500">room: <span className="text-black font-bold">{displayCode}</span></div>
					) : (
						<div />
					)}
					<div className="text-xs text-gray-500">{state.phase}</div>
				</div>

				{/* Lobby */}
				{state.phase === "lobby" && (
					<div>
						{state.packetName && (
							<div className="mb-2 text-xs text-gray-500">packet: <span className="text-black font-bold">{state.packetName}</span></div>
						)}
						<div className="mb-3 text-xs text-gray-500">
							share code: <span className="text-black font-bold text-lg">{displayCode}</span>
						</div>

					{isModerator && state.players.length >= 1 && (
						<button type="button" onClick={startGame} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white mt-4">
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
						<button type="button" onClick={cancelTts} className="ml-2 underline hover:text-black">cancel</button>
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
			{(state.phase === "reading_tossup" || state.phase === "awaiting_answer" || (state.phase === "paused" && !state.bonus) || (state.phase === "judging" && !state.bonus) || (state.phase === "between_questions" && !state.bonus)) && state.tossup && (
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
							<AnswerInput onSubmit={submitAnswer} onTyping={sendTyping} timeMs={state.awaitAnswer.timeMs} />
						</div>
					)}

					{state.phase === "awaiting_answer" && !isMyBuzz && state.awaitAnswer && (
						<div className="mt-2 text-xs text-gray-500">
							waiting for {state.awaitAnswer.playerName} to answer...
							{state.answerTyping && <span className="ml-2 font-mono">"{state.answerTyping.text}"</span>}
						</div>
					)}

					{state.phase === "judging" && !state.bonus && (
						<div className="mt-2 text-xs text-gray-500">judging...</div>
					)}

					{state.lastResult && state.phase !== "between_questions" && (
						<div className={`mt-2 text-xs ${state.lastResult.correct ? "text-green-700" : "text-red-700"}`}>
							{state.lastResult.playerName}: "{state.lastResult.answer}" — {state.lastResult.correct ? `correct (+${state.lastResult.points})` : `incorrect (${state.lastResult.points})`}
						</div>
					)}


				</div>
			)}

			{/* Bonus */}
			{(state.phase === "reading_bonus" || state.phase === "bonus_answering" || (state.phase === "paused" && state.bonus != null) || (state.phase === "judging" && state.bonus != null) || (state.phase === "between_questions" && state.bonus != null)) && state.bonus && (
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

					{state.phase === "reading_bonus" && canBuzzBonus && (
						<BuzzButton onBuzz={buzz} disabled={false} />
					)}

					{state.phase === "bonus_answering" && canAnswerBonus && state.awaitBonusAnswer && (
						<AnswerInput onSubmit={submitBonusAnswer} onTyping={sendTyping} timeMs={state.awaitBonusAnswer.timeMs} label="bonus answer" />
					)}

					{state.phase === "bonus_answering" && !canAnswerBonus && (
						<div className="text-xs text-gray-500 mt-2">
							waiting for answer...
							{state.answerTyping && <span className="ml-2 font-mono">"{state.answerTyping.text}"</span>}
						</div>
					)}

					{state.phase === "judging" && state.bonus != null && (
						<div className="text-xs text-gray-500 mt-2">judging...</div>
					)}


				</div>
			)}

			{/* Dead tossup message */}
			{state.deadAnswer && !["reading_tossup", "reading_bonus", "bonus_answering"].includes(state.phase) && (
				<div className="text-xs text-gray-500 mb-2">
					dead tossup — answer: <span className="font-bold text-black">{state.deadAnswer}</span>
				</div>
			)}

			{/* Between questions */}
			{state.phase === "between_questions" && (() => {
				const isLastQuestion = state.tossup != null && state.tossup.questionNumber === state.tossup.totalQuestions;
				const sortedPlayers = [...state.players].sort((a, b) => b.score - a.score);
				const topScore = sortedPlayers[0]?.score ?? 0;
				const winners = sortedPlayers.filter((p) => p.score === topScore);
				return (
					<div>
						{state.lastResult && (
							<div className={`mb-2 text-xs ${state.lastResult.correct ? "text-green-700" : "text-red-700"}`}>
								{state.lastResult.playerName}: "{state.lastResult.answer}" — {state.lastResult.correct ? `correct (+${state.lastResult.points})` : `incorrect (${state.lastResult.points})`}
							</div>
						)}
						{state.bonus?.totalPoints != null && (
							<div className="mb-2 text-xs text-gray-500">bonus total: {state.bonus.totalPoints}/30</div>
						)}

						{isLastQuestion ? (
							<div>
								<div className="mt-2 mb-3 text-sm font-bold">
									{winners.length === 1
										? `winner: ${winners[0].name} (${topScore})`
										: `tie: ${winners.map((w) => w.name).join(", ")} (${topScore})`}
								</div>
								{isModerator && (
									<button type="button" onClick={endGame} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
										end game
									</button>
								)}
							</div>
						) : (
							<button type="button" onClick={nextQuestion} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
								next question
							</button>
						)}
					</div>
				);
			})()}

			{/* Game over */}
			{state.phase === "game_over" && (
				<div>
					<div className="mb-3 font-bold">game over</div>
					<button type="button" onClick={() => navigate("/play")} className="border border-black px-4 py-1 text-sm hover:bg-black hover:text-white">
						back to lobby
					</button>
				</div>
			)}

			{/* Paused banner */}
			{state.phase === "paused" && (
				<div className="my-4 border border-black px-4 py-3 text-sm flex items-center justify-between">
					<span className="font-bold">paused</span>
					<button type="button" onClick={resume} className="text-xs underline hover:text-gray-500">resume (p)</button>
				</div>
			)}

			{/* Moderator controls (fixed drawer) */}
			{isModerator && state.phase !== "game_over" && (
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

			{state.error && <div className="mt-3 text-red-700 text-xs">{state.error}</div>}

			{/* Question History */}
			{state.phase !== "lobby" && (
				<QuestionHistory history={state.history} />
			)}
			</div>
		</>
	);
}
