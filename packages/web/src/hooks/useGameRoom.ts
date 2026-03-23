import { useCallback, useEffect, useReducer, useRef } from "react";
import { type GameSocket, createGameSocket } from "../lib/ws";

type GamePhase =
	| "lobby"
	| "reading_tossup"
	| "player_buzzed"
	| "awaiting_answer"
	| "judging"
	| "reading_bonus"
	| "bonus_answering"
	| "between_questions"
	| "paused"
	| "game_over";

type Team = "a" | "b";

interface PlayerInfo {
	id: string;
	name: string;
	score: number;
	powers: number;
	tens: number;
	negs: number;
	isModerator: boolean;
	team?: Team;
}

interface TossupState {
	questionNumber: number;
	totalQuestions: number;
	category: string;
	subcategory: string;
	words: string[];
	currentBuzzes: { playerName: string; buzzWordIndex: number; correct: boolean; points: number; answer: string }[];
	isPowerZone: boolean;
	audioUrl?: string;
}

interface BonusState {
	leadin: string;
	controllingPlayerName: string;
	controllingTeam?: Team;
	category: string;
	subcategory: string;
	words: string[];
	currentPart: { partNumber: number; value: number; audioUrl?: string } | null;
	partResults: { partNumber: number; correct: boolean; answer: string; submittedAnswer: string; points: number; partText?: string }[];
	totalPoints: number | null;
	audioUrl?: string;
}

interface AnswerResult {
	playerId: string;
	playerName: string;
	answer: string;
	correct: boolean;
	points: number;
}

export interface HistoryEntry {
	type: "tossup" | "bonus";
	questionNumber: number;
	category: string;
	subcategory: string;
	// Tossup fields
	questionText?: string;
	answer: string;
	buzzes?: { playerName: string; buzzWordIndex: number; correct: boolean; points: number; answer: string }[];
	dead?: boolean;
	// Bonus fields
	controllingPlayer?: string;
	partResults?: { partNumber: number; correct: boolean; answer: string; submittedAnswer: string; points: number; partText?: string }[];
	totalBonusPoints?: number;
}

export interface GameState {
	connected: boolean;
	roomCode: string | null;
	playerId: string | null;
	phase: GamePhase;
	players: PlayerInfo[];
	tossup: TossupState | null;
	bonus: BonusState | null;
	awaitAnswer: { playerId: string; playerName: string; timeMs: number } | null;
	awaitBonusAnswer: { controllingPlayerId: string; timeMs: number } | null;
	lastResult: AnswerResult | null;
	deadAnswer: string | null;
	gameOverPlayers: PlayerInfo[] | null;
	error: string | null;
	buzzedPlayer: { id: string; name: string } | null;
	kicked: boolean;
	neggedPlayerIds: Set<string>;
	ttsProgress: { current: number; total: number; etaMs?: number } | null;
	history: HistoryEntry[];
	answerTyping: { playerName: string; text: string } | null;
}

type Action =
	| { type: "connected" }
	| { type: "disconnected" }
	| { type: "room_created"; roomCode: string; playerId: string }
	| { type: "room_joined"; roomCode: string; playerId: string }
	| { type: "player_list"; players: PlayerInfo[] }
	| { type: "phase_change"; phase: GamePhase }
	| { type: "tossup_start"; questionNumber: number; totalQuestions: number; category: string; subcategory: string; audioUrl?: string }
	| { type: "word_reveal"; wordIndex: number; word: string; isPowerZone: boolean }
	| { type: "player_buzzed"; playerId: string; playerName: string }
	| { type: "answer_result"; playerId: string; playerName: string; answer: string; correct: boolean; points: number; buzzWordIndex: number; words?: string[] }
	| { type: "tossup_dead"; answer: string; words?: string[] }
	| { type: "bonus_start"; leadin: string; controllingPlayerName: string; controllingTeam?: Team; category: string; subcategory: string; audioUrl?: string }
	| { type: "bonus_part"; partNumber: number; totalWords: number; value: number; audioUrl?: string }
	| { type: "bonus_word_reveal"; word: string }
	| { type: "bonus_part_result"; partNumber: number; correct: boolean; answer: string; submittedAnswer: string; points: number; partText: string }
	| { type: "bonus_complete"; totalBonusPoints: number }
	| { type: "game_over"; players: PlayerInfo[] }
	| { type: "error"; message: string }
	| { type: "await_answer"; playerId: string; playerName: string; timeMs: number }
	| { type: "await_bonus_answer"; controllingPlayerId: string; timeMs: number }
	| { type: "player_kicked"; playerId: string; playerName: string }
	| { type: "player_disconnected"; playerId: string; playerName: string }
	| { type: "player_reconnected"; playerId: string; playerName: string }
	| { type: "tts_progress"; current: number; total: number; etaMs?: number }
	| { type: "answer_typing"; playerName: string; text: string }
	| { type: "clear_error" }
	| { type: "clear_result" };

const initialState: GameState = {
	connected: false,
	roomCode: null,
	playerId: null,
	phase: "lobby",
	players: [],
	tossup: null,
	bonus: null,
	awaitAnswer: null,
	awaitBonusAnswer: null,
	lastResult: null,
	deadAnswer: null,
	gameOverPlayers: null,
	error: null,
	buzzedPlayer: null,
	kicked: false,
	neggedPlayerIds: new Set(),
	ttsProgress: null,
	history: [],
	answerTyping: null,
};

function reducer(state: GameState, action: Action): GameState {
	switch (action.type) {
		case "connected":
			return { ...state, connected: true };
		case "disconnected":
			return { ...state, connected: false };
		case "room_created":
			return { ...state, roomCode: action.roomCode, playerId: action.playerId };
		case "room_joined":
			return { ...state, roomCode: action.roomCode, playerId: action.playerId };
		case "player_list":
			return { ...state, players: action.players };
		case "phase_change":
			return {
				...state,
				phase: action.phase,
				// Clear transient state on phase transitions
				...(action.phase === "reading_tossup" ? { awaitAnswer: null, deadAnswer: null, buzzedPlayer: null, awaitBonusAnswer: null } : {}),
				...(action.phase === "between_questions" ? { awaitAnswer: null, awaitBonusAnswer: null, buzzedPlayer: null } : {}),
			};
		case "tts_progress":
			return { ...state, ttsProgress: action.current >= action.total ? null : { current: action.current, total: action.total, etaMs: action.etaMs } };
		case "tossup_start":
			return {
				...state,
				ttsProgress: null,
				tossup: {
					questionNumber: action.questionNumber,
					totalQuestions: action.totalQuestions,
					category: action.category,
					subcategory: action.subcategory,
					words: [],
					currentBuzzes: [],
					isPowerZone: true,
					audioUrl: action.audioUrl,
				},
				lastResult: null,
				deadAnswer: null,
				bonus: null,
				neggedPlayerIds: new Set(),
				error: null,
				// Reset history on first question of a new game
				...(action.questionNumber === 1 ? { history: [] } : {}),
			};
		case "word_reveal":
			if (!state.tossup) return state;
			return {
				...state,
				tossup: {
					...state.tossup,
					words: [...state.tossup.words, action.word],
					isPowerZone: action.isPowerZone,
				},
			};
		case "player_buzzed":
			return { ...state, buzzedPlayer: { id: action.playerId, name: action.playerName } };
		case "answer_result": {
			const neggedPlayerIds = new Set(state.neggedPlayerIds);
			if (!action.correct) neggedPlayerIds.add(action.playerId);
			const newBuzz = {
				playerName: action.playerName,
				buzzWordIndex: action.buzzWordIndex,
				correct: action.correct,
				points: action.points,
				answer: action.answer,
			};
			const currentBuzzes = state.tossup ? [...state.tossup.currentBuzzes, newBuzz] : [];
			// Add tossup result to history when correct (incorrect buzzes don't end the tossup)
			const historyAfterResult = action.correct && state.tossup
				? [...state.history, {
					type: "tossup" as const,
					questionNumber: state.tossup.questionNumber,
					category: state.tossup.category,
					subcategory: state.tossup.subcategory,
					questionText: action.words?.join(" ") ?? state.tossup.words.join(" "),
					answer: action.answer,
					buzzes: currentBuzzes,
					dead: false,
				}]
				: state.history;
			return {
				...state,
				neggedPlayerIds,
				history: historyAfterResult,
				tossup: state.tossup ? { ...state.tossup, currentBuzzes } : null,
				lastResult: {
					playerId: action.playerId,
					playerName: action.playerName,
					answer: action.answer,
					correct: action.correct,
					points: action.points,
				},
				buzzedPlayer: null,
				answerTyping: null,
			};
		}
		case "tossup_dead":
			return {
				...state,
				deadAnswer: action.answer,
				tossup: state.tossup ? { ...state.tossup } : null,
				history: state.tossup
					? [...state.history, {
						type: "tossup" as const,
						questionNumber: state.tossup.questionNumber,
						category: state.tossup.category,
						subcategory: state.tossup.subcategory,
						questionText: action.words?.join(" ") ?? state.tossup.words.join(" "),
						answer: action.answer,
						buzzes: state.tossup.currentBuzzes,
						dead: true,
					}]
					: state.history,
			};
		case "bonus_start":
			return {
				...state,
				bonus: {
					leadin: action.leadin,
					controllingPlayerName: action.controllingPlayerName,
					controllingTeam: action.controllingTeam,
					category: action.category,
					subcategory: action.subcategory,
					words: [],
					currentPart: null,
					partResults: [],
					totalPoints: null,
					audioUrl: action.audioUrl,
				},
			};
		case "bonus_part":
			if (!state.bonus) return state;
			return {
				...state,
				bonus: {
					...state.bonus,
					words: [],
					currentPart: { partNumber: action.partNumber, value: action.value, audioUrl: action.audioUrl },
				},
			};
		case "bonus_word_reveal":
			if (!state.bonus) return state;
			return {
				...state,
				bonus: {
					...state.bonus,
					words: [...state.bonus.words, action.word],
				},
			};
		case "bonus_part_result":
			if (!state.bonus) return state;
			return {
				...state,
				answerTyping: null,
				bonus: {
					...state.bonus,
					currentPart: null,
					words: [],
					partResults: [
						...state.bonus.partResults,
						{
							partNumber: action.partNumber,
							correct: action.correct,
							answer: action.answer,
							submittedAnswer: action.submittedAnswer,
							points: action.points,
							partText: action.partText,
						},
					],
				},
			};
		case "bonus_complete":
			if (!state.bonus) return state;
			return {
				...state,
				bonus: { ...state.bonus, totalPoints: action.totalBonusPoints },
				history: [...state.history, {
					type: "bonus" as const,
					questionNumber: state.tossup?.questionNumber ?? 0,
					category: state.bonus.category,
					subcategory: state.bonus.subcategory,
					answer: "",
					controllingPlayer: state.bonus.controllingPlayerName,
					partResults: state.bonus.partResults,
					totalBonusPoints: action.totalBonusPoints,
				}],
			};
		case "game_over":
			return { ...state, gameOverPlayers: action.players };
		case "error":
			return { ...state, error: action.message };
		case "await_answer":
			return { ...state, awaitAnswer: { playerId: action.playerId, playerName: action.playerName, timeMs: action.timeMs } };
		case "await_bonus_answer":
			return { ...state, awaitBonusAnswer: { controllingPlayerId: action.controllingPlayerId, timeMs: action.timeMs } };
		case "player_kicked":
			return state.playerId === action.playerId ? { ...state, kicked: true } : state;
		case "player_disconnected":
		case "player_reconnected":
			return state; // player_list update handles this
		case "answer_typing":
			return { ...state, answerTyping: { playerName: action.playerName, text: action.text } };
		case "clear_error":
			return { ...state, error: null };
		case "clear_result":
			return { ...state, lastResult: null };
		default:
			return state;
	}
}

export function useGameRoom() {
	const [state, dispatch] = useReducer(reducer, initialState);
	const socketRef = useRef<GameSocket | null>(null);

	useEffect(() => {
		return () => {
			socketRef.current?.close();
		};
	}, []);

	const connect = useCallback(() => {
		if (socketRef.current) return;
		const socket = createGameSocket();
		socketRef.current = socket;

		socket.ready
			.then(() => dispatch({ type: "connected" }))
			.catch(() => dispatch({ type: "disconnected" }));

		socket.onMessage((msg) => {
			dispatch(msg as Action);
		});

		socket.onClose(() => {
			dispatch({ type: "disconnected" });
		});
	}, []);

	const send = useCallback((msg: Record<string, unknown>) => {
		socketRef.current?.send(msg);
	}, []);

	const createRoom = useCallback(
		async (questionSetId: string, playerName: string, mode: "ffa" | "teams", options?: { ttsEnabled?: boolean, includeBonuses?: boolean, leniency?: number, msPerWord?: number }) => {
			connect();
			try {
				await socketRef.current?.ready;
			} catch {
				return; // disconnect handler already dispatched
			}
			send({ type: "create_room", questionSetId, playerName, mode, ttsEnabled: options?.ttsEnabled, includeBonuses: options?.includeBonuses, strictness: options?.leniency, msPerWord: options?.msPerWord });
		},
		[connect, send],
	);

	const joinRoom = useCallback(
		async (roomCode: string, playerName: string) => {
			connect();
			try {
				await socketRef.current?.ready;
			} catch {
				return;
			}
			send({ type: "join_room", roomCode, playerName });
		},
		[connect, send],
	);

	const pause = useCallback(() => send({ type: "pause" }), [send]);
	const resume = useCallback(() => send({ type: "resume" }), [send]);
	const buzz = useCallback(() => send({ type: "buzz" }), [send]);
	const submitAnswer = useCallback((answer: string) => send({ type: "submit_answer", answer }), [send]);
	const submitBonusAnswer = useCallback((answer: string) => send({ type: "submit_bonus_answer", answer }), [send]);
	const startGame = useCallback(() => send({ type: "start_game" }), [send]);
	const nextQuestion = useCallback(() => send({ type: "next_question" }), [send]);
	const skip = useCallback(() => send({ type: "skip" }), [send]);
	const endGame = useCallback(() => send({ type: "end_game" }), [send]);
	const kickPlayer = useCallback((playerId: string) => send({ type: "kick_player", playerId }), [send]);
	const setTeam = useCallback((playerId: string, team: "a" | "b") => send({ type: "set_team", playerId, team }), [send]);
	const updateSettings = useCallback((settings: { strictness?: number; msPerWord?: number }) => send({ type: "update_settings", ...settings }), [send]);
	const sendAudioReady = useCallback(() => send({ type: "audio_ready" }), [send]);
	const cancelTts = useCallback(() => send({ type: "cancel_tts" }), [send]);
	const sendTyping = useCallback((text: string) => send({ type: "answer_typing", text }), [send]);
	const clearError = useCallback(() => dispatch({ type: "clear_error" }), []);
	const disconnect = useCallback(() => {
		socketRef.current?.close();
		socketRef.current = null;
	}, []);

	return {
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
		clearError,
		disconnect,
	};
}
