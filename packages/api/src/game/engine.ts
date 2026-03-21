import { createLogger } from "@3roads/shared";
import { judgeAnswer } from "./judge.js";
import { generateTTS, storeAudio } from "./tts.js";
import type { GameRoom, Player, ServerMessage, TossupReading } from "./types.js";

const log = createLogger("api:game:engine");

// -- Broadcast helpers --

export function broadcast(room: GameRoom, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const player of room.players.values()) {
		try {
			if (player.ws.readyState === player.ws.OPEN) {
				player.ws.send(data);
			}
		} catch {
			// ignore send errors
		}
	}
}

export function sendTo(player: Player, msg: ServerMessage): void {
	try {
		if (player.ws.readyState === player.ws.OPEN) {
			player.ws.send(JSON.stringify(msg));
		}
	} catch {
		// ignore
	}
}

export function broadcastPlayerList(room: GameRoom): void {
	broadcast(room, {
		type: "player_list",
		players: Array.from(room.players.values()).map((p) => ({
			id: p.id,
			name: p.name,
			score: p.score,
			powers: p.powers,
			tens: p.tens,
			negs: p.negs,
			isModerator: p.isModerator,
			team: p.team,
		})),
	});
}

// -- Word splitting and power mark --

function charIndexToWordIndex(text: string, charIndex: number): number {
	const words = text.split(/\s+/);
	let pos = 0;
	for (let i = 0; i < words.length; i++) {
		pos += words[i].length;
		if (pos >= charIndex) return i;
		pos++; // space
	}
	return words.length - 1;
}

// -- Shuffle --

function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

// -- Game flow --

export function startGame(room: GameRoom): void {
	room.tossups = shuffle(room.tossups);
	room.bonuses = shuffle(room.bonuses);
	room.currentQuestionIndex = 0;

	// Reset scores
	for (const p of room.players.values()) {
		p.score = 0;
		p.powers = 0;
		p.tens = 0;
		p.negs = 0;
	}

	log.info(`Room ${room.code} — game started, ${room.tossups.length} tossups, ${room.bonuses.length} bonuses`);
	broadcastPlayerList(room);
	startTossup(room);
}

export async function startTossup(room: GameRoom): Promise<void> {
	if (room.currentQuestionIndex >= room.tossups.length) {
		endGame(room);
		return;
	}

	const tossup = room.tossups[room.currentQuestionIndex];
	const words = tossup.question.split(/\s+/);
	const powerMarkWordIndex = tossup.powerMarkIndex != null
		? charIndexToWordIndex(tossup.question, tossup.powerMarkIndex)
		: null;

	room.tossupReading = {
		tossupIndex: room.currentQuestionIndex,
		words,
		revealedCount: 0,
		powerMarkWordIndex,
		answer: tossup.answer,
		intervalHandle: null,
		buzzedPlayerId: null,
		buzzWordIndex: null,
		incorrectBuzzers: new Set(),
	};

	room.phase = "reading_tossup";
	room.lastActivity = Date.now();

	// Generate TTS if enabled
	let audioUrl: string | undefined;
	let msPerWord = room.settings.msPerWord;
	if (room.settings.ttsEnabled) {
		try {
			const { audio, durationMs } = await generateTTS(tossup.question);
			const audioId = storeAudio(audio);
			audioUrl = `/audio/${audioId}`;
			msPerWord = durationMs / words.length;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`TTS failed for tossup, falling back to text-only: ${msg}`);
			broadcast(room, { type: "error", message: `TTS unavailable: ${msg}` });
			room.settings.ttsEnabled = false; // disable for rest of game to avoid repeated failures
		}
	}

	broadcast(room, { type: "phase_change", phase: "reading_tossup" });
	broadcast(room, {
		type: "tossup_start",
		questionNumber: room.currentQuestionIndex + 1,
		totalQuestions: room.tossups.length,
		category: tossup.category,
		subcategory: tossup.subcategory,
		audioUrl,
	});

	// Start word-by-word reveal
	room.tossupReading.intervalHandle = setInterval(() => {
		revealNextWord(room);
	}, msPerWord);
}

function revealNextWord(room: GameRoom): void {
	const tr = room.tossupReading;
	if (!tr || room.phase !== "reading_tossup") return;

	if (tr.revealedCount >= tr.words.length) {
		// All words revealed, wait a moment then mark dead
		if (tr.intervalHandle) {
			clearInterval(tr.intervalHandle);
			tr.intervalHandle = null;
		}
		// Give a short window for buzzing after last word, then dead
		setTimeout(() => {
			if (room.phase === "reading_tossup" && room.tossupReading === tr) {
				tossupDead(room);
			}
		}, 2000);
		return;
	}

	const wordIndex = tr.revealedCount;
	const word = tr.words[wordIndex];
	const isPowerZone = tr.powerMarkWordIndex != null && wordIndex <= tr.powerMarkWordIndex;

	broadcast(room, {
		type: "word_reveal",
		wordIndex,
		word,
		isPowerZone,
	});

	tr.revealedCount++;
}

export function handleBuzz(room: GameRoom, playerId: string): void {
	const tr = room.tossupReading;
	if (!tr) return;
	if (room.phase !== "reading_tossup") return;

	const player = room.players.get(playerId);
	if (!player) return;

	if (tr.incorrectBuzzers.has(playerId)) {
		sendTo(player, { type: "error", message: "You already buzzed incorrectly on this tossup" });
		return;
	}

	// Stop word reveal
	if (tr.intervalHandle) {
		clearInterval(tr.intervalHandle);
		tr.intervalHandle = null;
	}

	tr.buzzedPlayerId = playerId;
	tr.buzzWordIndex = tr.revealedCount;

	room.phase = "awaiting_answer";
	room.lastActivity = Date.now();

	broadcast(room, { type: "phase_change", phase: "awaiting_answer" });
	broadcast(room, { type: "player_buzzed", playerId, playerName: player.name });
	broadcast(room, {
		type: "await_answer",
		playerId,
		playerName: player.name,
		timeMs: room.settings.answerTimeMs,
	});

	// Answer timeout
	room.answerTimer = setTimeout(() => {
		if (room.phase === "awaiting_answer" && tr.buzzedPlayerId === playerId) {
			handleAnswer(room, playerId, "");
		}
	}, room.settings.answerTimeMs);
}

export async function handleAnswer(room: GameRoom, playerId: string, answer: string): Promise<void> {
	const tr = room.tossupReading;
	if (!tr || tr.buzzedPlayerId !== playerId) return;
	if (room.phase !== "awaiting_answer") return;

	if (room.answerTimer) {
		clearTimeout(room.answerTimer);
		room.answerTimer = null;
	}

	const player = room.players.get(playerId);
	if (!player) return;

	room.phase = "judging";
	broadcast(room, { type: "phase_change", phase: "judging" });

	const tossup = room.tossups[room.currentQuestionIndex];
	const bonusIndex = room.currentQuestionIndex;
	const questionText = tr.words.slice(0, tr.revealedCount).join(" ");

	const { correct } = await judgeAnswer(
		answer,
		tossup.answer,
		questionText,
		room.settings.strictness,
	);

	// Guard: if game state moved on during async judging (e.g. skip/end), bail out
	if (room.tossupReading !== tr) return;

	room.lastActivity = Date.now();

	if (correct) {
		const inPowerZone = tr.powerMarkWordIndex != null &&
			tr.buzzWordIndex != null &&
			tr.buzzWordIndex <= tr.powerMarkWordIndex;
		const points = inPowerZone ? 15 : 10;

		player.score += points;
		if (inPowerZone) player.powers++;
		else player.tens++;

		broadcast(room, {
			type: "answer_result",
			playerId,
			playerName: player.name,
			answer,
			correct: true,
			points,
		});

		broadcastPlayerList(room);

		// Brief pause to show correct answer before moving to bonus
		await new Promise((r) => setTimeout(r, 2000));

		// Guard: if game state moved on during the pause, bail out
		if (room.tossupReading !== tr) return;

		// Move to bonus if available
		if (bonusIndex < room.bonuses.length) {
			startBonus(room, playerId, bonusIndex);
		} else {
			advanceToNextQuestion(room);
		}
	} else {
		player.score -= 5;
		player.negs++;
		tr.incorrectBuzzers.add(playerId);
		tr.buzzedPlayerId = null;
		tr.buzzWordIndex = null;

		broadcast(room, {
			type: "answer_result",
			playerId,
			playerName: player.name,
			answer,
			correct: false,
			points: -5,
		});

		broadcastPlayerList(room);

		// Check if all players have negged
		const activePlayers = Array.from(room.players.values());
		const allNegged = activePlayers.every((p) => tr.incorrectBuzzers.has(p.id));

		if (allNegged) {
			tossupDead(room);
		} else {
			// Resume tossup reading
			resumeTossup(room);
		}
	}
}

function resumeTossup(room: GameRoom): void {
	const tr = room.tossupReading;
	if (!tr) return;

	room.phase = "reading_tossup";
	broadcast(room, { type: "phase_change", phase: "reading_tossup" });

	if (tr.revealedCount >= tr.words.length) {
		// All words already revealed — give brief window, then dead
		setTimeout(() => {
			if (room.phase === "reading_tossup" && room.tossupReading === tr) {
				tossupDead(room);
			}
		}, 2000);
		return;
	}

	tr.intervalHandle = setInterval(() => {
		revealNextWord(room);
	}, room.settings.msPerWord);
}

function tossupDead(room: GameRoom): void {
	const tr = room.tossupReading;
	if (!tr) return;

	if (tr.intervalHandle) {
		clearInterval(tr.intervalHandle);
		tr.intervalHandle = null;
	}

	broadcast(room, { type: "tossup_dead", answer: tr.answer });
	advanceToNextQuestion(room);
}

async function startBonus(room: GameRoom, controllingPlayerId: string, bonusIndex: number): Promise<void> {
	const bonus = room.bonuses[bonusIndex];
	if (!bonus) {
		advanceToNextQuestion(room);
		return;
	}

	const controllingPlayer = room.players.get(controllingPlayerId);
	if (!controllingPlayer) {
		advanceToNextQuestion(room);
		return;
	}

	room.bonusReading = {
		bonusIndex,
		leadin: bonus.leadin,
		parts: bonus.parts.map((p) => ({ text: p.text, answer: p.answer, value: p.value })),
		currentPart: 0,
		controllingPlayerId,
		controllingTeam: controllingPlayer.team,
		partScores: bonus.parts.map(() => null),
		intervalHandle: null,
	};

	room.phase = "reading_bonus";
	room.lastActivity = Date.now();

	// Generate TTS for leadin if enabled
	let audioUrl: string | undefined;
	if (room.settings.ttsEnabled) {
		try {
			const { audio } = await generateTTS(bonus.leadin);
			const audioId = storeAudio(audio);
			audioUrl = `/audio/${audioId}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`TTS failed for bonus leadin: ${msg}`);
			broadcast(room, { type: "error", message: `TTS unavailable: ${msg}` });
			room.settings.ttsEnabled = false;
		}
	}

	broadcast(room, { type: "phase_change", phase: "reading_bonus" });
	broadcast(room, {
		type: "bonus_start",
		leadin: "",
		controllingPlayerName: controllingPlayer.name,
		controllingTeam: controllingPlayer.team,
		category: bonus.category,
		subcategory: bonus.subcategory,
		audioUrl,
	});

	// Reveal leadin word-by-word, then start first part
	const leadinWords = bonus.leadin.split(/\s+/);
	let i = 0;
	const br = room.bonusReading;
	br.intervalHandle = setInterval(() => {
		if (i < leadinWords.length) {
			broadcast(room, { type: "bonus_word_reveal", word: leadinWords[i] });
			i++;
		} else {
			if (br.intervalHandle) {
				clearInterval(br.intervalHandle);
				br.intervalHandle = null;
			}
			// Brief pause after leadin finishes before first part
			setTimeout(() => {
				sendBonusPart(room);
			}, 1000);
		}
	}, room.settings.msPerWord);
}

async function sendBonusPart(room: GameRoom): Promise<void> {
	const br = room.bonusReading;
	if (!br || br.currentPart >= br.parts.length) {
		completeBonus(room);
		return;
	}

	const part = br.parts[br.currentPart];
	const partWords = part.text.split(/\s+/);

	// Generate TTS for bonus part if enabled
	let audioUrl: string | undefined;
	if (room.settings.ttsEnabled) {
		try {
			const { audio } = await generateTTS(part.text);
			const audioId = storeAudio(audio);
			audioUrl = `/audio/${audioId}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`TTS failed for bonus part: ${msg}`);
			broadcast(room, { type: "error", message: `TTS unavailable: ${msg}` });
			room.settings.ttsEnabled = false;
		}
	}

	room.phase = "reading_bonus";
	broadcast(room, { type: "phase_change", phase: "reading_bonus" });
	broadcast(room, {
		type: "bonus_part",
		partNumber: br.currentPart + 1,
		totalWords: partWords.length,
		value: part.value,
		audioUrl,
	});

	// Reveal part text word-by-word, then open for answering
	let i = 0;
	br.intervalHandle = setInterval(() => {
		if (i < partWords.length) {
			broadcast(room, { type: "bonus_word_reveal", word: partWords[i] });
			i++;
		} else {
			if (br.intervalHandle) {
				clearInterval(br.intervalHandle);
				br.intervalHandle = null;
			}
			// Now open for answering
			room.phase = "bonus_answering";
			broadcast(room, { type: "phase_change", phase: "bonus_answering" });
			broadcast(room, {
				type: "await_bonus_answer",
				controllingPlayerId: br.controllingPlayerId,
				timeMs: room.settings.bonusAnswerTimeMs,
			});

			room.answerTimer = setTimeout(() => {
				if (room.phase === "bonus_answering" && room.bonusReading === br) {
					handleBonusAnswer(room, "");
				}
			}, room.settings.bonusAnswerTimeMs);
		}
	}, room.settings.msPerWord);
}

export async function handleBonusAnswer(room: GameRoom, answer: string): Promise<void> {
	const br = room.bonusReading;
	if (!br) return;
	if (room.phase !== "bonus_answering") return;

	if (room.answerTimer) {
		clearTimeout(room.answerTimer);
		room.answerTimer = null;
	}

	const part = br.parts[br.currentPart];
	room.phase = "judging";
	broadcast(room, { type: "phase_change", phase: "judging" });

	const { correct } = await judgeAnswer(
		answer,
		part.answer,
		part.text,
		room.settings.strictness,
	);

	// Guard: if game state moved on during async judging, bail out
	if (room.bonusReading !== br) return;

	room.lastActivity = Date.now();
	br.partScores[br.currentPart] = correct;

	const points = correct ? part.value : 0;

	// Award points to controlling player (or team)
	if (correct) {
		if (room.mode === "teams" && br.controllingTeam) {
			// In team mode, points go to the buzzer
			const buzzer = room.players.get(br.controllingPlayerId);
			if (buzzer) buzzer.score += points;
		} else {
			const player = room.players.get(br.controllingPlayerId);
			if (player) player.score += points;
		}
	}

	broadcast(room, {
		type: "bonus_part_result",
		partNumber: br.currentPart + 1,
		correct,
		answer: part.answer,
		submittedAnswer: answer,
		points,
	});

	broadcastPlayerList(room);

	br.currentPart++;

	if (br.currentPart >= br.parts.length) {
		completeBonus(room);
	} else {
		setTimeout(() => {
			sendBonusPart(room);
		}, 1500);
	}
}

function completeBonus(room: GameRoom): void {
	const br = room.bonusReading;
	if (!br) return;

	const totalBonusPoints = br.partScores.reduce((sum, correct, i) => {
		return sum + (correct ? br.parts[i].value : 0);
	}, 0);

	broadcast(room, { type: "bonus_complete", totalBonusPoints });
	advanceToNextQuestion(room);
}

function advanceToNextQuestion(room: GameRoom): void {
	if (room.bonusReading?.intervalHandle) {
		clearInterval(room.bonusReading.intervalHandle);
	}
	room.currentQuestionIndex++;
	room.tossupReading = null;
	room.bonusReading = null;

	if (room.currentQuestionIndex >= room.tossups.length) {
		endGame(room);
		return;
	}

	room.phase = "between_questions";
	room.lastActivity = Date.now();
	broadcast(room, { type: "phase_change", phase: "between_questions" });
	broadcastPlayerList(room);
}

export function skipQuestion(room: GameRoom): void {
	const tr = room.tossupReading;
	if (tr?.intervalHandle) {
		clearInterval(tr.intervalHandle);
		tr.intervalHandle = null;
	}
	const br = room.bonusReading;
	if (br?.intervalHandle) {
		clearInterval(br.intervalHandle);
		br.intervalHandle = null;
	}
	if (room.answerTimer) {
		clearTimeout(room.answerTimer);
		room.answerTimer = null;
	}

	if (room.tossupReading) {
		broadcast(room, { type: "tossup_dead", answer: room.tossupReading.answer });
	}

	advanceToNextQuestion(room);
}

export function endGame(room: GameRoom): void {
	if (room.tossupReading?.intervalHandle) {
		clearInterval(room.tossupReading.intervalHandle);
	}
	if (room.bonusReading?.intervalHandle) {
		clearInterval(room.bonusReading.intervalHandle);
	}
	if (room.answerTimer) {
		clearTimeout(room.answerTimer);
		room.answerTimer = null;
	}

	room.phase = "game_over";
	room.lastActivity = Date.now();

	const players = Array.from(room.players.values())
		.sort((a, b) => b.score - a.score)
		.map((p) => ({
			id: p.id,
			name: p.name,
			score: p.score,
			powers: p.powers,
			tens: p.tens,
			negs: p.negs,
			team: p.team,
		}));

	broadcast(room, { type: "phase_change", phase: "game_over" });
	broadcast(room, { type: "game_over", players });
}

export function nextQuestion(room: GameRoom): void {
	if (room.phase !== "between_questions") return;
	startTossup(room);
}
