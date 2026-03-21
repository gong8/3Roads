import { useCallback, useEffect, useRef } from "react";
import type { GameState } from "./useGameRoom";

const API_BASE = import.meta.env.DEV ? `http://${window.location.hostname}:7001` : "";

export function useGameAudio(state: GameState): void {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const prevPhaseRef = useRef(state.phase);

	const stop = useCallback(() => {
		const a = audioRef.current;
		if (a) {
			console.log("[tts] stop");
			a.pause();
			a.removeAttribute("src");
			a.load(); // release resources per HTML spec
			audioRef.current = null;
		}
	}, []);

	const play = useCallback((url: string) => {
		console.log("[tts] play", url);
		// Clean up previous audio element properly
		const old = audioRef.current;
		if (old) {
			old.pause();
			old.removeAttribute("src");
			old.load();
		}
		const a = new Audio(`${API_BASE}${url}`);
		audioRef.current = a;
		a.play().catch((err) => {
			console.warn("[tts] autoplay blocked:", err);
		});
	}, []);

	// Play tossup audio
	const tossupAudioUrl = state.tossup?.audioUrl;
	useEffect(() => {
		if (tossupAudioUrl) {
			console.log("[tts] tossup effect:", tossupAudioUrl);
			play(tossupAudioUrl);
		}
	}, [tossupAudioUrl, play]);

	// Play bonus leadin audio
	const bonusAudioUrl = state.bonus?.audioUrl;
	useEffect(() => {
		if (bonusAudioUrl) {
			console.log("[tts] bonus leadin effect:", bonusAudioUrl);
			play(bonusAudioUrl);
		}
	}, [bonusAudioUrl, play]);

	// Play bonus part audio
	const partAudioUrl = state.bonus?.currentPart?.audioUrl;
	useEffect(() => {
		if (partAudioUrl) {
			console.log("[tts] bonus part effect:", partAudioUrl);
			play(partAudioUrl);
		}
	}, [partAudioUrl, play]);

	// Pause/resume/stop on phase changes
	const phase = state.phase;
	useEffect(() => {
		const prev = prevPhaseRef.current;
		prevPhaseRef.current = phase;

		const a = audioRef.current;
		if (!a) return;

		if (phase === "awaiting_answer") {
			console.log("[tts] pause (awaiting_answer)");
			a.pause();
		} else if (phase === "reading_tossup" && (prev === "judging" || prev === "awaiting_answer")) {
			console.log("[tts] resume (reading_tossup from", prev, ")");
			a.play().catch(() => {});
		} else if (phase !== prev && (phase === "between_questions" || phase === "game_over" || phase === "lobby")) {
			console.log("[tts] stop (phase:", phase, ")");
			stop();
		}
	}, [phase, stop]);

	// Stop on tossup dead
	const deadAnswer = state.deadAnswer;
	useEffect(() => {
		if (deadAnswer) {
			console.log("[tts] stop (dead tossup)");
			stop();
		}
	}, [deadAnswer, stop]);

	// Cleanup on unmount
	useEffect(() => stop, [stop]);
}
