import { createLogger } from "@3roads/shared";
import { judgeAnswer } from "./judge.js";
import { generateTTS, storeAudio } from "./tts.js";
import type { GameRoom, Player, ServerMessage, TossupReading } from "./types.js";

const log = createLogger("api:game:engine");

// -- Word timing helpers --

const MIN_WORD_WEIGHT = 2; // minimum effective character weight (so "a" isn't near-zero)
const PAUSE_WEIGHT = 1;    // extra weight per word to model inter-word pauses

/**
 * Compute per-word delays proportional to character length.
 * Distributes totalDurationMs across words so longer words get more time.
 */
function computeWordDelays(words: string[], totalDurationMs: number): number[] {
	const weights = words.map((w) => Math.max(w.length, MIN_WORD_WEIGHT) + PAUSE_WEIGHT);
	const totalWeight = weights.reduce((sum, w) => sum + w, 0);
	return weights.map((w) => (w / totalWeight) * totalDurationMs);
}

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

export async function pregenerateTTS(room: GameRoom): Promise<void> {
	if (!room.settings.ttsEnabled) return;

	const abort = new AbortController();
	room.ttsAbort = abort;

	try {
		log.info(`Room ${room.code} — pregenerating TTS audio...`);
		const texts: { key: string; text: string }[] = [];
		for (const t of room.tossups) {
			texts.push({ key: `tossup:${t.id}`, text: t.question });
		}
		for (const b of room.bonuses) {
			texts.push({ key: `bonus-leadin:${b.id}`, text: b.leadin });
			for (const p of b.parts) {
				texts.push({ key: `bonus-part:${b.id}:${p.partNum}`, text: p.text });
			}
		}

		broadcast(room, { type: "tts_progress", current: 0, total: texts.length });
		const startTime = Date.now();
		let completed = 0;
		let failed = 0;
		await Promise.all(
			texts.map(async ({ key, text }) => {
				if (abort.signal.aborted) return;
				try {
					const words = text.split(/\s+/);
					const { audio, durationMs, wordDelays } = await generateTTS(text, words);
					if (abort.signal.aborted) return;
					const audioId = storeAudio(audio);
					room.ttsCache.set(key, { audioId, durationMs, wordDelays });
				} catch (err) {
					if (abort.signal.aborted) return;
					failed++;
					log.warn(`Room ${room.code} — TTS failed for "${key}": ${err instanceof Error ? err.message : err}`);
				}
				completed++;
				const elapsed = Date.now() - startTime;
				const avgMs = elapsed / completed;
				const etaMs = Math.round(avgMs * (texts.length - completed));
				broadcast(room, { type: "tts_progress", current: completed, total: texts.length, etaMs });
			}),
		);
		if (!abort.signal.aborted) {
			log.info(`Room ${room.code} — TTS pregeneration complete (${texts.length - failed}/${texts.length} clips)`);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn(`Room ${room.code} — TTS pregeneration failed, disabling: ${msg}`);
		broadcast(room, { type: "error", message: `TTS unavailable: ${msg}` });
		room.settings.ttsEnabled = false;
	}
}

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
	let powerMarkWordIndex: number | null = null;
	for (let i = 0; i < words.length; i++) {
		if (words[i].includes("(*)")) {
			powerMarkWordIndex = i;
			break;
		}
	}
	if (powerMarkWordIndex === null && tossup.powerMarkIndex != null) {
		powerMarkWordIndex = charIndexToWordIndex(tossup.question, tossup.powerMarkIndex);
	}

	// Look up pregenerated TTS audio
	let audioUrl: string | undefined;
	let wordDelays: number[];
	if (room.settings.ttsEnabled) {
		const cached = room.ttsCache.get(`tossup:${tossup.id}`);
		if (cached) {
			audioUrl = `/audio/${cached.audioId}`;
			if (cached.wordDelays && cached.wordDelays.length === words.length) {
				wordDelays = cached.wordDelays;
			} else {
				wordDelays = computeWordDelays(words, cached.durationMs);
			}
		} else {
			wordDelays = computeWordDelays(words, room.settings.msPerWord * words.length);
		}
	} else {
		wordDelays = computeWordDelays(words, room.settings.msPerWord * words.length);
	}

	room.tossupReading = {
		tossupIndex: room.currentQuestionIndex,
		words,
		wordDelays,
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

	broadcast(room, { type: "phase_change", phase: "reading_tossup" });
	broadcast(room, {
		type: "tossup_start",
		questionNumber: room.currentQuestionIndex + 1,
		totalQuestions: room.tossups.length,
		category: tossup.category,
		subcategory: tossup.subcategory,
		audioUrl,
	});

	const startWordReveals = () => {
		// First word immediately so it syncs with audio start
		revealNextWord(room);
		// Chain setTimeout for remaining words with per-word weighted delays
		const scheduleNext = (index: number) => {
			if (index >= words.length) return;
			room.tossupReading!.intervalHandle = setTimeout(() => {
				revealNextWord(room);
				scheduleNext(index + 1);
			}, wordDelays[index]);
		};
		scheduleNext(1); // word 0 already revealed
	};

	if (audioUrl) {
		// TTS enabled — wait for client to signal audio is actually playing
		waitForAudioReady(room, startWordReveals);
	} else {
		startWordReveals();
	}
}

const AUDIO_READY_TIMEOUT_MS = 3000;

function waitForAudioReady(room: GameRoom, callback: () => void): void {
	room.pendingAudioReady = callback;
	room.audioReadyTimeout = setTimeout(() => {
		if (room.pendingAudioReady) {
			log.warn(`Room ${room.code} — audio_ready timeout, starting word reveals anyway`);
			const fn = room.pendingAudioReady;
			room.pendingAudioReady = null;
			room.audioReadyTimeout = null;
			fn();
		}
	}, AUDIO_READY_TIMEOUT_MS);
}

function cancelPendingAudioReady(room: GameRoom): void {
	if (room.audioReadyTimeout) {
		clearTimeout(room.audioReadyTimeout);
		room.audioReadyTimeout = null;
	}
	room.pendingAudioReady = null;
}

export function handleAudioReady(room: GameRoom): void {
	if (room.pendingAudioReady) {
		if (room.audioReadyTimeout) {
			clearTimeout(room.audioReadyTimeout);
			room.audioReadyTimeout = null;
		}
		const fn = room.pendingAudioReady;
		room.pendingAudioReady = null;
		fn();
	}
}

function revealNextWord(room: GameRoom): void {
	const tr = room.tossupReading;
	if (!tr || room.phase !== "reading_tossup") return;

	if (tr.revealedCount >= tr.words.length) {
		// All words revealed, wait a moment then mark dead
		if (tr.intervalHandle) {
			clearTimeout(tr.intervalHandle);
			tr.intervalHandle = null;
		}
		// Give a short window for buzzing after last word, then dead
		setTimeout(() => {
			if (room.phase === "reading_tossup" && room.tossupReading === tr) {
				tossupDead(room);
			}
		}, 1000);
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

	// Stop word reveal (or cancel pending start)
	cancelPendingAudioReady(room);
	if (tr.intervalHandle) {
		clearTimeout(tr.intervalHandle);
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

	// Answer timeout with 1s grace period for client auto-submit
	room.answerTimerDuration = room.settings.answerTimeMs + 1000;
	room.answerTimerStartedAt = Date.now();
	room.answerTimer = setTimeout(() => {
		if (room.phase === "awaiting_answer" && tr.buzzedPlayerId === playerId) {
			handleAnswer(room, playerId, "");
		}
	}, room.answerTimerDuration);
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
			buzzWordIndex: tr.buzzWordIndex!,
			words: tr.words,
		});

		broadcastPlayerList(room);

		// Brief pause to show correct answer before moving to bonus
		await new Promise((r) => setTimeout(r, 800));

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
			buzzWordIndex: tr.buzzWordIndex!,
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
		}, 1000);
		return;
	}

	// Resume with weighted delays from where we left off
	const scheduleNext = (index: number) => {
		if (index >= tr.words.length) return;
		tr.intervalHandle = setTimeout(() => {
			revealNextWord(room);
			scheduleNext(index + 1);
		}, tr.wordDelays[index]);
	};
	scheduleNext(tr.revealedCount);
}

function tossupDead(room: GameRoom): void {
	const tr = room.tossupReading;
	if (!tr) return;

	cancelPendingAudioReady(room);
	if (tr.intervalHandle) {
		clearTimeout(tr.intervalHandle);
		tr.intervalHandle = null;
	}

	broadcast(room, { type: "tossup_dead", answer: tr.answer, words: tr.words });
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
		inLeadin: true,
		leadinRevealedCount: 0,
		partRevealedCount: 0,
	};

	room.phase = "reading_bonus";
	room.lastActivity = Date.now();

	// Look up pregenerated TTS audio for leadin
	let audioUrl: string | undefined;
	if (room.settings.ttsEnabled) {
		const cached = room.ttsCache.get(`bonus-leadin:${bonus.id}`);
		if (cached) {
			audioUrl = `/audio/${cached.audioId}`;
		}
	}

	broadcast(room, { type: "phase_change", phase: "reading_bonus" });
	broadcast(room, {
		type: "bonus_start",
		leadin: bonus.leadin,
		controllingPlayerName: controllingPlayer.name,
		controllingTeam: controllingPlayer.team,
		category: bonus.category,
		subcategory: bonus.subcategory,
		audioUrl,
	});

	// Reveal leadin word-by-word, then start first part
	const leadinWords = bonus.leadin.split(/\s+/);
	let leadinDelays: number[];
	let leadinTotalMs = room.settings.msPerWord * leadinWords.length;
	if (room.settings.ttsEnabled) {
		const cachedLeadin = room.ttsCache.get(`bonus-leadin:${bonus.id}`);
		if (cachedLeadin) {
			leadinTotalMs = cachedLeadin.durationMs;
			if (cachedLeadin.wordDelays && cachedLeadin.wordDelays.length === leadinWords.length) {
				leadinDelays = cachedLeadin.wordDelays;
			} else {
				leadinDelays = computeWordDelays(leadinWords, leadinTotalMs);
			}
		} else {
			leadinDelays = computeWordDelays(leadinWords, leadinTotalMs);
		}
	} else {
		leadinDelays = computeWordDelays(leadinWords, leadinTotalMs);
	}

	const br = room.bonusReading;

	const startLeadinReveals = (fromIndex = 0) => {
		if (leadinWords.length > 0 && fromIndex === 0) {
			broadcast(room, { type: "bonus_word_reveal", word: leadinWords[0] });
			br.leadinRevealedCount = 1;
		}
		const scheduleNext = (i: number) => {
			if (i >= leadinWords.length) {
				br.intervalHandle = null;
				br.inLeadin = false;
				// Brief pause after leadin finishes before first part
				const avgDelay = leadinTotalMs / leadinWords.length;
				const leadinPause = room.settings.ttsEnabled ? Math.max(avgDelay, 500) : 1000;
				setTimeout(() => {
					sendBonusPart(room);
				}, leadinPause);
				return;
			}
			br.intervalHandle = setTimeout(() => {
				broadcast(room, { type: "bonus_word_reveal", word: leadinWords[i] });
				br.leadinRevealedCount = i + 1;
				scheduleNext(i + 1);
			}, leadinDelays[i]);
		};
		scheduleNext(fromIndex === 0 ? 1 : fromIndex);
	};

	if (audioUrl) {
		waitForAudioReady(room, startLeadinReveals);
	} else {
		startLeadinReveals();
	}
}

async function sendBonusPart(room: GameRoom): Promise<void> {
	const br = room.bonusReading;
	if (!br || br.currentPart >= br.parts.length) {
		completeBonus(room);
		return;
	}

	const part = br.parts[br.currentPart];
	const partWords = part.text.split(/\s+/);

	// Look up pregenerated TTS audio for bonus part
	let audioUrl: string | undefined;
	if (room.settings.ttsEnabled) {
		const bonus = room.bonuses[br.bonusIndex];
		const partNum = bonus.parts[br.currentPart]?.partNum ?? br.currentPart + 1;
		const cached = room.ttsCache.get(`bonus-part:${bonus.id}:${partNum}`);
		if (cached) {
			audioUrl = `/audio/${cached.audioId}`;
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

	// Compute word timing from TTS cache when available
	let partDelays: number[];
	if (room.settings.ttsEnabled) {
		const bonus = room.bonuses[br.bonusIndex];
		const partNum = bonus.parts[br.currentPart]?.partNum ?? br.currentPart + 1;
		const cachedPart = room.ttsCache.get(`bonus-part:${bonus.id}:${partNum}`);
		if (cachedPart) {
			if (cachedPart.wordDelays && cachedPart.wordDelays.length === partWords.length) {
				partDelays = cachedPart.wordDelays;
			} else {
				partDelays = computeWordDelays(partWords, cachedPart.durationMs);
			}
		} else {
			partDelays = computeWordDelays(partWords, room.settings.msPerWord * partWords.length);
		}
	} else {
		partDelays = computeWordDelays(partWords, room.settings.msPerWord * partWords.length);
	}

	br.partRevealedCount = 0;

	const startPartReveals = (fromIndex = 0) => {
		if (partWords.length > 0 && fromIndex === 0) {
			broadcast(room, { type: "bonus_word_reveal", word: partWords[0] });
			br.partRevealedCount = 1;
		}
		const scheduleNext = (i: number) => {
			if (i >= partWords.length) {
				br.intervalHandle = null;
				openBonusAnswering(room, br);
				return;
			}
			br.intervalHandle = setTimeout(() => {
				broadcast(room, { type: "bonus_word_reveal", word: partWords[i] });
				br.partRevealedCount = i + 1;
				scheduleNext(i + 1);
			}, partDelays[i]);
		};
		scheduleNext(fromIndex === 0 ? 1 : fromIndex);
	};

	if (audioUrl) {
		waitForAudioReady(room, startPartReveals);
	} else {
		startPartReveals();
	}
}

function openBonusAnswering(room: GameRoom, br: NonNullable<GameRoom["bonusReading"]>): void {
	room.phase = "bonus_answering";
	broadcast(room, { type: "phase_change", phase: "bonus_answering" });
	broadcast(room, {
		type: "await_bonus_answer",
		controllingPlayerId: br.controllingPlayerId,
		timeMs: room.settings.bonusAnswerTimeMs,
	});

	room.answerTimerDuration = room.settings.bonusAnswerTimeMs + 1000;
	room.answerTimerStartedAt = Date.now();
	room.answerTimer = setTimeout(() => {
		if (room.phase === "bonus_answering" && room.bonusReading === br) {
			handleBonusAnswer(room, "");
		}
	}, room.answerTimerDuration);
}

export function handleBonusBuzz(room: GameRoom, playerId: string): void {
	const br = room.bonusReading;
	if (!br) return;
	if (room.phase !== "reading_bonus") return;

	// Only allow controlling player (or teammate in team mode) to buzz
	const player = room.players.get(playerId);
	if (!player) return;

	if (room.mode === "ffa") {
		if (br.controllingPlayerId !== playerId) return;
	} else {
		const controlling = room.players.get(br.controllingPlayerId);
		if (controlling?.team !== player.team) return;
	}

	// Stop word reveal
	if (br.intervalHandle) {
		clearTimeout(br.intervalHandle);
		br.intervalHandle = null;
	}

	// Transition to bonus answering
	room.lastActivity = Date.now();
	openBonusAnswering(room, br);
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
		partText: part.text,
	});

	broadcastPlayerList(room);

	br.currentPart++;

	if (br.currentPart >= br.parts.length) {
		completeBonus(room);
	} else {
		setTimeout(() => {
			sendBonusPart(room);
		}, 800);
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
		clearTimeout(room.bonusReading.intervalHandle);
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

export function pauseGame(room: GameRoom): void {
	const pauseablePhases = ["reading_tossup", "reading_bonus", "between_questions", "judging"];
	if (!pauseablePhases.includes(room.phase)) return;

	room.pausedPhase = room.phase;

	// Stop word reveal timers
	cancelPendingAudioReady(room);
	const tr = room.tossupReading;
	if (tr?.intervalHandle) {
		clearTimeout(tr.intervalHandle);
		tr.intervalHandle = null;
	}
	const br = room.bonusReading;
	if (br?.intervalHandle) {
		clearTimeout(br.intervalHandle);
		br.intervalHandle = null;
	}

	// Stop answer timer and record remaining time
	if (room.answerTimer && room.answerTimerStartedAt != null && room.answerTimerDuration != null) {
		clearTimeout(room.answerTimer);
		room.answerTimer = null;
		room.answerTimerRemaining = Math.max(0, room.answerTimerDuration - (Date.now() - room.answerTimerStartedAt));
	}

	room.phase = "paused";
	room.lastActivity = Date.now();
	broadcast(room, { type: "phase_change", phase: "paused" });
	log.info(`Room ${room.code} — paused (was ${room.pausedPhase})`);
}

export function resumeGame(room: GameRoom): void {
	if (room.phase !== "paused" || !room.pausedPhase) return;

	const resumePhase = room.pausedPhase;
	room.pausedPhase = null;
	room.phase = resumePhase;
	room.lastActivity = Date.now();

	broadcast(room, { type: "phase_change", phase: resumePhase });
	log.info(`Room ${room.code} — resumed to ${resumePhase}`);

	// Resume word reveals or answer timers from where we left off
	if (resumePhase === "reading_tossup") {
		const tr = room.tossupReading;
		if (tr && tr.revealedCount < tr.words.length) {
			const scheduleNext = (index: number) => {
				if (index >= tr.words.length) return;
				tr.intervalHandle = setTimeout(() => {
					revealNextWord(room);
					scheduleNext(index + 1);
				}, tr.wordDelays[index]);
			};
			scheduleNext(tr.revealedCount);
		}
	} else if (resumePhase === "reading_bonus") {
		const br = room.bonusReading;
		if (br) {
			if (br.inLeadin) {
				// Resume leadin word reveals from current position
				const leadinWords = br.leadin.split(/\s+/);
				const leadinDelays = computeWordDelays(leadinWords, room.settings.msPerWord * leadinWords.length);
				const from = br.leadinRevealedCount;
				const scheduleNext = (i: number) => {
					if (i >= leadinWords.length) {
						br.intervalHandle = null;
						br.inLeadin = false;
						const leadinPause = 1000;
						setTimeout(() => { sendBonusPart(room); }, leadinPause);
						return;
					}
					br.intervalHandle = setTimeout(() => {
						broadcast(room, { type: "bonus_word_reveal", word: leadinWords[i] });
						br.leadinRevealedCount = i + 1;
						scheduleNext(i + 1);
					}, leadinDelays[i]);
				};
				scheduleNext(from);
			} else {
				// Resume part word reveals from current position (no bonus_part re-broadcast)
				const part = br.parts[br.currentPart];
				const partWords = part.text.split(/\s+/);
				const partDelays = computeWordDelays(partWords, room.settings.msPerWord * partWords.length);
				const from = br.partRevealedCount;
				if (from >= partWords.length) {
					// All words already revealed, just open answering
					openBonusAnswering(room, br);
				} else {
					const scheduleNext = (i: number) => {
						if (i >= partWords.length) {
							br.intervalHandle = null;
							openBonusAnswering(room, br);
							return;
						}
						br.intervalHandle = setTimeout(() => {
							broadcast(room, { type: "bonus_word_reveal", word: partWords[i] });
							br.partRevealedCount = i + 1;
							scheduleNext(i + 1);
						}, partDelays[i]);
					};
					scheduleNext(from);
				}
			}
		}
	}
}

export function skipQuestion(room: GameRoom): void {
	cancelPendingAudioReady(room);
	const tr = room.tossupReading;
	if (tr?.intervalHandle) {
		clearTimeout(tr.intervalHandle);
		tr.intervalHandle = null;
	}
	const br = room.bonusReading;
	if (br?.intervalHandle) {
		clearTimeout(br.intervalHandle);
		br.intervalHandle = null;
	}
	if (room.answerTimer) {
		clearTimeout(room.answerTimer);
		room.answerTimer = null;
	}

	if (room.tossupReading) {
		broadcast(room, { type: "tossup_dead", answer: room.tossupReading.answer, words: room.tossupReading.words });
	}

	advanceToNextQuestion(room);
}

export function endGame(room: GameRoom): void {
	cancelPendingAudioReady(room);
	if (room.tossupReading?.intervalHandle) {
		clearTimeout(room.tossupReading.intervalHandle);
	}
	if (room.bonusReading?.intervalHandle) {
		clearTimeout(room.bonusReading.intervalHandle);
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
