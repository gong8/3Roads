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
	/** Infinite mode: the next question is still being written */
	| "waiting_for_questions"
	| "game_over";

export type GameMode = "ffa" | "teams";
export type Team = "a" | "b";

export interface Player {
	id: string;
	name: string;
	ws: WebSocket;
	score: number;
	bonusScore: number;
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
	imageUrl?: string;
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
	isPicture: boolean;
	/** Prompts given on the current buzz */
	promptCount: number;
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
	/** Prompts given on the current part */
	promptCount: number;
}

export interface GameSettings {
	msPerWord: number;
	answerTimeMs: number;
	bonusAnswerTimeMs: number;
	strictness: number;
	/** Ask an LLM about answers the local matcher is unsure of */
	aiJudge: boolean;
	ttsEnabled: boolean;
}

/** What an infinite room writes its questions about, and how it is going. */
export interface InfiniteSettings {
	theme: string;
	difficulty: string;
	/** How the host wants questions written, e.g. "university challenge style" */
	style?: string;
	model: string;
	/** The host, whose plan (or the server's OpenRouter key) pays for generation */
	userId: string;
	includeBonuses: boolean;
}

export interface InfiniteState extends InfiniteSettings {
	/** Every question written is saved into this set, so it can be replayed later */
	setId: string;
	/** OpenRouter spend on generation and judging; null while everything has run on a ChatGPT plan */
	cost: number | null;
	generating: boolean;
	/** Batches in a row that produced no questions; generation gives up after a few */
	failures: number;
	error: string | null;
	/** Set when the game ends so in-flight batches don't start more */
	stopped: boolean;
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
	/** Present for infinite rooms, which write questions as the game goes */
	infinite: InfiniteState | null;
	/** Wrong tossup answers on the latest tossup, which another player (or a solo player) can mark correct once it ends */
	tossupMisses: TossupMiss[];
}

// -- Client -> Server messages --

export interface ExternalPacket {
	name: string;
	tossups: TossupData[];
	bonuses: BonusData[];
}

export interface CreateRoomMsg {
	type: "create_room";
	/** Local DB set ID — required unless externalPacket is provided */
	questionSetId?: string;
	/** Pre-fetched packet data (e.g. from QB Reader) — skips DB lookup */
	externalPacket?: ExternalPacket;
	playerName: string;
	mode: GameMode;
	ttsEnabled?: boolean;
	includeBonuses?: boolean;
	strictness?: number;
	aiJudge?: boolean;
	msPerWord?: number;
	/** Write questions on this theme as the game goes, instead of playing a set */
	infinite?: { theme: string; difficulty: string; style?: string; model?: string };
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
	aiJudge?: boolean;
	msPerWord?: number;
}

export interface PauseMsg {
	type: "pause";
}

export interface ResumeMsg {
	type: "resume";
}

export interface AnswerTypingMsg {
	type: "answer_typing";
	text: string;
}

/** The chat message being typed, so others see it live; empty when it's sent or abandoned. */
export interface ChatTypingMsg {
	type: "chat_typing";
	text: string;
}

/** A wrong tossup answer that may later be overridden to correct. */
export interface TossupMiss {
	playerId: string;
	/** Points the miss cost: -5 for a neg, 0 after the question was fully read */
	penalty: number;
	/** Whether the buzz came early enough to have been a power */
	inPowerZone: boolean;
	overridden: boolean;
}

/** Mark a wrong tossup answer correct: by another player, or by yourself when playing alone. */
export interface OverrideAnswerMsg {
	type: "override_answer";
	playerId: string;
}

export interface ChatMsg {
	type: "chat";
	text: string;
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
	| ResumeMsg
	| AnswerTypingMsg
	| OverrideAnswerMsg
	| ChatTypingMsg
	| ChatMsg;

// -- Server -> Client messages --

export interface RoomCreatedEvt {
	type: "room_created";
	roomCode: string;
	playerId: string;
	packetName: string;
}

export interface RoomJoinedEvt {
	type: "room_joined";
	roomCode: string;
	playerId: string;
	packetName: string;
}

export interface PlayerListEvt {
	type: "player_list";
	players: { id: string; name: string; score: number; bonusScore: number; powers: number; tens: number; negs: number; isModerator: boolean; team?: Team }[];
}

export interface PhaseChangeEvt {
	type: "phase_change";
	phase: GamePhase;
}

export interface TossupStartEvt {
	type: "tossup_start";
	questionNumber: number;
	/** 0 in infinite mode, where there is no last question */
	totalQuestions: number;
	category: string;
	subcategory: string;
	audioUrl?: string;
	imageUrl?: string;
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
	correctAnswer?: string;
	correct: boolean;
	points: number;
	buzzWordIndex: number;
	words?: string[];
}

export interface AnswerPromptEvt {
	type: "answer_prompt";
	playerId: string;
	playerName: string;
	answer: string;
	isBonus: boolean;
}

export interface InfiniteStatusEvt {
	type: "infinite_status";
	theme: string;
	difficulty: string;
	model: string;
	/** OpenRouter dollars spent so far; null when everything ran on a ChatGPT plan */
	cost: number | null;
	generating: boolean;
	/** Written questions not yet played */
	ready: number;
	/** Questions written so far */
	written: number;
	error: string | null;
}

export interface AnswerOverriddenEvt {
	type: "answer_overridden";
	playerId: string;
	playerName: string;
	/** Who marked it correct */
	byName: string;
	points: number;
}

export interface ChatEvt {
	type: "chat";
	playerId: string;
	playerName: string;
	text: string;
	sentAt: number;
}

export interface TossupDeadEvt {
	type: "tossup_dead";
	answer: string;
	words: string[];
}

export interface PictureBuzzWindowEvt {
	type: "picture_buzz_window";
	timeMs: number;
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
	maxBonusPoints: number;
}

export interface GameOverEvt {
	type: "game_over";
	players: { id: string; name: string; score: number; bonusScore: number; powers: number; tens: number; negs: number; team?: Team }[];
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

export interface ChatTypingEvt {
	type: "chat_typing";
	playerId: string;
	playerName: string;
	text: string;
}

export interface AnswerTypingEvt {
	type: "answer_typing";
	playerName: string;
	text: string;
}

export interface GameSyncEvt {
	type: "game_sync";
	tossup: {
		questionNumber: number;
		totalQuestions: number;
		category: string;
		subcategory: string;
		words: string[];
		isPowerZone: boolean;
		currentBuzzes: { playerName: string; buzzWordIndex: number; correct: boolean; points: number; answer: string }[];
		imageUrl?: string;
	} | null;
	bonus: {
		leadin: string;
		controllingPlayerName: string;
		controllingTeam?: Team;
		category: string;
		subcategory: string;
		words: string[];
		currentPart: { partNumber: number; value: number } | null;
		partResults: { partNumber: number; correct: boolean; answer: string; submittedAnswer: string; points: number; partText: string }[];
		totalPoints: number | null;
		maxBonusPoints: number;
	} | null;
	buzzedPlayer: { id: string; name: string } | null;
	awaitAnswer: { playerId: string; playerName: string; timeMs: number } | null;
	awaitBonusAnswer: { controllingPlayerId: string; timeMs: number } | null;
	neggedPlayerIds: string[];
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
	| AnswerPromptEvt
	| ChatEvt
	| AnswerOverriddenEvt
	| ChatTypingEvt
	| InfiniteStatusEvt
	| TossupDeadEvt
	| PictureBuzzWindowEvt
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
	| TtsProgressEvt
	| AnswerTypingEvt
	| GameSyncEvt;
