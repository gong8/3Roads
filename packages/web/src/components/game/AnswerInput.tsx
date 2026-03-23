import { useEffect, useRef, useState } from "react";

interface Props {
	onSubmit: (answer: string) => void;
	onTyping?: (text: string) => void;
	timeMs: number;
	label?: string;
	disabled?: boolean;
}

export function AnswerInput({ onSubmit, onTyping, timeMs, label = "your answer", disabled = false }: Props) {
	const [value, setValue] = useState("");
	const [remaining, setRemaining] = useState(timeMs);
	const inputRef = useRef<HTMLInputElement>(null);
	const startRef = useRef(Date.now());

	const valueRef = useRef(value);
	valueRef.current = value;

	useEffect(() => {
		inputRef.current?.focus();
		startRef.current = Date.now();
		let autoSubmitted = false;
		const interval = setInterval(() => {
			const elapsed = Date.now() - startRef.current;
			const left = Math.max(0, timeMs - elapsed);
			setRemaining(left);
			if (left === 0 && !autoSubmitted) {
				autoSubmitted = true;
				if (!disabled) onSubmit(valueRef.current);
				clearInterval(interval);
			}
		}, 100);
		return () => clearInterval(interval);
	}, [timeMs, disabled, onSubmit]);

	const handleSubmit = () => {
		if (disabled) return;
		onSubmit(value);
		setValue("");
	};

	return (
		<div className="border border-black p-3">
			<div className="flex justify-between text-xs text-gray-500 mb-2">
				<span>{label}</span>
				<span>{(remaining / 1000).toFixed(1)}s</span>
			</div>
			<div className="flex gap-2">
				<input
					ref={inputRef}
					type="text"
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						onTyping?.(e.target.value);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleSubmit();
					}}
					disabled={disabled}
					className="flex-1 border border-black px-2 py-1 text-sm font-mono"
					placeholder="type answer..."
				/>
				<button
					type="button"
					onClick={handleSubmit}
					disabled={disabled}
					className="border border-black px-3 py-1 text-sm hover:bg-black hover:text-white"
				>
					submit
				</button>
			</div>
		</div>
	);
}
