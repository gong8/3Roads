import type { WebSocket } from "ws";

// Game phases
export type GamePhase =
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

export type GameMode = "ffa" | "teams";
export type Team = "a" | "b";

export interface Player {
	id: string;
	name: string;
	ws: WebSocket;
	score: number;
	powers: number;
	tens: number;
	negs: number;
	isModerator: boolean;
	team?: Team;
}

export interface TossupData {
	id: string;
	question: string;
	answer: string;
	powerMarkIndex: number | null;
	category: string;
	subcategory: string;
	difficulty: string;
}

export interface BonusData {
	id: string;
	leadin: string;
	category: string;
	subcategory: string;
	difficulty: string;
	parts: { partNum: number; text: string; answer: string; value: number }[];
}

export interface TossupReading {
	tossupIndex: number;
	words: string[];
	wordDelays: number[];
	revealedCount: number;
	powerMarkWordIndex: number | null;
	answer: string;
	intervalHandle: ReturnType<typeof setTimeout> | null;
	buzzedPlayerId: string | null;
	buzzWordIndex: number | null;
	incorrectBuzzers: Set<string>;
}

export interface BonusReading {
	bonusIndex: number;
	leadin: string;
	parts: { text: string; answer: string; value: number }[];
	currentPart: number;
	controllingPlayerId: string;
	controllingTeam?: Team;
	partScores: (boolean | null)[];
	intervalHandle: ReturnType<typeof setTimeout> | null;
	inLeadin: boolean;
	leadinRevealedCount: number;
	partRevealedCount: number;
}

export interface GameSettings {
	msPerWord: number;
	answerTimeMs: number;
	bonusAnswerTimeMs: number;
	strictness: number;
	ttsEnabled: boolean;
}

export interface GameRoom {
	code: string;
	questionSetId: string;
	questionSetName: string;
	mode: GameMode;
	players: Map<string, Player>;
	phase: GamePhase;
	tossups: TossupData[];
	bonuses: BonusData[];
	currentQuestionIndex: number;
	tossupReading: TossupReading | null;
	bonusReading: BonusReading | null;
	settings: GameSettings;
	lastActivity: number;
	answerTimer: ReturnType<typeof setTimeout> | null;
	answerTimerStartedAt: number | null;
	answerTimerDuration: number | null;
	pausedPhase: GamePhase | null;
	answerTimerRemaining: number | null;
	ttsCache: Map<string, { audioId: string; durationMs: number; wordDelays: number[] | null }>;
	pendingAudioReady: (() => void) | null;
	audioReadyTimeout: ReturnType<typeof setTimeout> | null;
	ttsAbort: AbortController | null;
}

// -- Client -> Server messages --

export interface CreateRoomMsg {
	type: "create_room";
	questionSetId: string;
	playerName: string;
	mode: GameMode;
	ttsEnabled?: boolean;
	includeBonuses?: boolean;
	strictness?: number;
	msPerWord?: number;
}

export interface JoinRoomMsg {
	type: "join_room";
	roomCode: string;
	playerName: string;
}

export interface StartGameMsg {
	type: "start_game";
}

export interface BuzzMsg {
	type: "buzz";
}

export interface SubmitAnswerMsg {
	type: "submit_answer";
	answer: string;
}

export interface SubmitBonusAnswerMsg {
	type: "submit_bonus_answer";
	answer: string;
}

export interface NextQuestionMsg {
	type: "next_question";
}

export interface SkipMsg {
	type: "skip";
}

export interface AudioReadyMsg {
	type: "audio_ready";
}

export interface CancelTtsMsg {
	type: "cancel_tts";
}

export interface EndGameMsg {
	type: "end_game";
}

export interface KickPlayerMsg {
	type: "kick_player";
	playerId: string;
}

export interface SetTeamMsg {
	type: "set_team";
	playerId: string;
	team: Team;
}

export interface UpdateSettingsMsg {
	type: "update_settings";
	strictness?: number;
	msPerWord?: number;
}

export interface PauseMsg {
	type: "pause";
}

export interface ResumeMsg {
	type: "resume";
}

export type ClientMessage =
	| CreateRoomMsg
	| JoinRoomMsg
	| StartGameMsg
	| BuzzMsg
	| SubmitAnswerMsg
	| SubmitBonusAnswerMsg
	| NextQuestionMsg
	| SkipMsg
	| EndGameMsg
	| KickPlayerMsg
	| SetTeamMsg
	| UpdateSettingsMsg
	| AudioReadyMsg
	| CancelTtsMsg
	| PauseMsg
	| ResumeMsg;

// -- Server -> Client messages --

export interface RoomCreatedEvt {
	type: "room_created";
	roomCode: string;
	playerId: string;
}

export interface RoomJoinedEvt {
	type: "room_joined";
	roomCode: string;
	playerId: string;
}

export interface PlayerListEvt {
	type: "player_list";
	players: { id: string; name: string; score: number; powers: number; tens: number; negs: number; isModerator: boolean; team?: Team }[];
}

export interface PhaseChangeEvt {
	type: "phase_change";
	phase: GamePhase;
}

export interface TossupStartEvt {
	type: "tossup_start";
	questionNumber: number;
	totalQuestions: number;
	category: string;
	subcategory: string;
	audioUrl?: string;
}

export interface WordRevealEvt {
	type: "word_reveal";
	wordIndex: number;
	word: string;
	isPowerZone: boolean;
}

export interface PlayerBuzzedEvt {
	type: "player_buzzed";
	playerId: string;
	playerName: string;
}

export interface AnswerResultEvt {
	type: "answer_result";
	playerId: string;
	playerName: string;
	answer: string;
	correct: boolean;
	points: number;
	buzzWordIndex: number;
	words?: string[];
}

export interface TossupDeadEvt {
	type: "tossup_dead";
	answer: string;
	words: string[];
}

export interface BonusStartEvt {
	type: "bonus_start";
	leadin: string;
	controllingPlayerName: string;
	controllingTeam?: Team;
	category: string;
	subcategory: string;
	audioUrl?: string;
}

export interface BonusPartEvt {
	type: "bonus_part";
	partNumber: number;
	totalWords: number;
	value: number;
	audioUrl?: string;
}

export interface BonusWordRevealEvt {
	type: "bonus_word_reveal";
	word: string;
}

export interface BonusPartResultEvt {
	type: "bonus_part_result";
	partNumber: number;
	correct: boolean;
	answer: string;
	submittedAnswer: string;
	points: number;
	partText: string;
}

export interface BonusCompleteEvt {
	type: "bonus_complete";
	totalBonusPoints: number;
}

export interface GameOverEvt {
	type: "game_over";
	players: { id: string; name: string; score: number; powers: number; tens: number; negs: number; team?: Team }[];
}

export interface ErrorEvt {
	type: "error";
	message: string;
}

export interface AwaitAnswerEvt {
	type: "await_answer";
	playerId: string;
	playerName: string;
	timeMs: number;
}

export interface AwaitBonusAnswerEvt {
	type: "await_bonus_answer";
	controllingPlayerId: string;
	timeMs: number;
}

export interface PlayerKickedEvt {
	type: "player_kicked";
	playerId: string;
	playerName: string;
}

export interface PlayerDisconnectedEvt {
	type: "player_disconnected";
	playerId: string;
	playerName: string;
}

export interface PlayerReconnectedEvt {
	type: "player_reconnected";
	playerId: string;
	playerName: string;
}

export interface TtsProgressEvt {
	type: "tts_progress";
	current: number;
	total: number;
	etaMs?: number;
}

export type ServerMessage =
	| RoomCreatedEvt
	| RoomJoinedEvt
	| PlayerListEvt
	| PhaseChangeEvt
	| TossupStartEvt
	| WordRevealEvt
	| PlayerBuzzedEvt
	| AnswerResultEvt
	| TossupDeadEvt
	| BonusStartEvt
	| BonusPartEvt
	| BonusWordRevealEvt
	| BonusPartResultEvt
	| BonusCompleteEvt
	| GameOverEvt
	| ErrorEvt
	| AwaitAnswerEvt
	| AwaitBonusAnswerEvt
	| PlayerKickedEvt
	| PlayerDisconnectedEvt
	| PlayerReconnectedEvt
	| TtsProgressEvt;
