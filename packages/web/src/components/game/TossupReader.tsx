import React, { useEffect, useState } from "react";
import { AnswerText } from "../AnswerText";

interface Props {
	words: string[];
	isPowerZone: boolean;
	category: string;
	subcategory: string;
	questionNumber: number;
	totalQuestions: number;
	imageUrl?: string;
	/** Buzzes on this tossup, marked where they happened once it's finished */
	buzzes?: { playerName: string; buzzWordIndex: number; correct: boolean }[];
	/** Set once the tossup is over: the rest of the question is shown in place, greyed */
	finished?: { words: string[]; answer: string; dead: boolean };
}

function BuzzChip({ name, correct }: { name: string; correct: boolean }) {
	return (
		<span className="inline-block mx-0.5 text-xs text-white bg-black px-1 rounded-sm font-normal">
			{name} ({correct ? "✓" : "✗"})
		</span>
	);
}

/**
 * The whole question: the part read before the end in black, the unread rest greyed, buzzes marked.
 * Like the history list, the power zone is bold and keeps its (*) marker.
 */
function FinishedText({ words, revealedCount, buzzes }: { words: string[]; revealedCount: number; buzzes: NonNullable<Props["buzzes"]> }) {
	const powerWordIndex = words.findIndex((w) => w.includes("(*)"));
	return (
		<p className="min-h-[3rem]">
			{words.map((w, i) => (
				<React.Fragment key={i}>
					{buzzes.filter((b) => b.buzzWordIndex === i).map((b) => <BuzzChip key={`${b.playerName}-${i}`} name={b.playerName} correct={b.correct} />)}
					{i > 0 && " "}
					<span className={`${i < revealedCount ? "" : "text-gray-500"} ${i <= powerWordIndex ? "font-bold" : ""}`}>{w}</span>
				</React.Fragment>
			))}
			{buzzes.filter((b) => b.buzzWordIndex >= words.length).map((b) => <BuzzChip key={`${b.playerName}-end`} name={b.playerName} correct={b.correct} />)}
		</p>
	);
}

const REVEAL_DELAY_SECONDS = 3;

export function TossupReader({ words, isPowerZone, category, subcategory, questionNumber, totalQuestions, imageUrl, buzzes = [], finished }: Props) {
	const [imageVisible, setImageVisible] = useState(false);
	const [countdown, setCountdown] = useState<number | null>(null);

	useEffect(() => {
		if (!imageUrl) {
			setImageVisible(false);
			setCountdown(null);
			return;
		}
		// New picture question — start countdown
		setImageVisible(false);
		setCountdown(REVEAL_DELAY_SECONDS);
		let remaining = REVEAL_DELAY_SECONDS;
		const id = setInterval(() => {
			remaining--;
			if (remaining <= 0) {
				clearInterval(id);
				setCountdown(null);
				setImageVisible(true);
			} else {
				setCountdown(remaining);
			}
		}, 1000);
		return () => clearInterval(id);
	}, [imageUrl]);

	return (
		<div className="border border-black p-3 mb-3">
			<div className="flex justify-between text-xs text-gray-500 mb-2">
				<span>{category} / {subcategory}</span>
				<span>{questionNumber} / {totalQuestions}</span>
			</div>
			{imageUrl && countdown !== null && (
				<div className="flex flex-col items-center justify-center h-40 border border-gray-200 mb-3 bg-gray-50">
					<div className="text-xs text-gray-400 mb-2 uppercase tracking-widest">picture question</div>
					<div className="text-5xl font-bold text-gray-700">{countdown}</div>
				</div>
			)}
			{imageUrl && imageVisible && (
				<div className="flex justify-center mb-3">
					<img src={imageUrl} alt="question image" className="max-h-64 max-w-full object-contain border border-gray-200" />
				</div>
			)}
			{finished ? (
				<>
					<FinishedText words={finished.words} revealedCount={words.length} buzzes={buzzes} />
					<div className="mt-2 text-xs">
						{finished.dead && <span className="text-gray-400 mr-1">dead tossup —</span>}
						<span className="text-gray-400">answer: </span>
						<span className="font-bold"><AnswerText answer={finished.answer} /></span>
					</div>
				</>
			) : words.length > 0 && (
				<p className="min-h-[3rem]" style={{ textWrap: "stable" } as React.CSSProperties}>
					{words.map(w => w.replace(/\(\*\)/g, "")).join(" ")}
					{/* Zero-width anchor: the cursor must not take up inline space, or "lastword|" wraps as one unit and the last word jumps lines */}
					<span className="relative" aria-hidden="true">
						<span className="absolute left-0 animate-pulse">|</span>
					</span>
				</p>
			)}
		</div>
	);
}
