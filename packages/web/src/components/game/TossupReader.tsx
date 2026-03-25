import React, { useEffect, useRef, useState } from "react";

interface Props {
	words: string[];
	isPowerZone: boolean;
	category: string;
	subcategory: string;
	questionNumber: number;
	totalQuestions: number;
	imageUrl?: string;
}

const REVEAL_DELAY_SECONDS = 3;

export function TossupReader({ words, isPowerZone, category, subcategory, questionNumber, totalQuestions, imageUrl }: Props) {
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
			{words.length > 0 && (
				<p className="min-h-[3rem]" style={{ textWrap: "stable" } as React.CSSProperties}>
					{words.map(w => w.replace(/\(\*\)/g, "")).join(" ")}
					<span className="animate-pulse">|</span>
				</p>
			)}
		</div>
	);
}
