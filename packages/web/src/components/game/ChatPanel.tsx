import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../hooks/useGameRoom";

interface Props {
	messages: ChatMessage[];
	currentPlayerId: string | null;
	open: boolean;
	onSend: (text: string) => void;
	onClose: () => void;
}

/** Room chat log. The input opens on Enter (handled by the page) and closes on send or Escape. */
export function ChatPanel({ messages, currentPlayerId, open, onSend, onClose }: Props) {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const logRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const lastSentAt = messages[messages.length - 1]?.sentAt;
	// Keyed on the newest message: the log is capped, so its length stops changing
	useEffect(() => {
		if (lastSentAt) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [lastSentAt]);

	if (messages.length === 0 && !open) {
		return <div className="mt-4 text-xs text-gray-400">press enter to chat</div>;
	}

	return (
		<div className="mt-4 border border-black p-2">
			<div ref={logRef} className="max-h-32 overflow-y-auto text-xs space-y-0.5">
				{messages.map((m) => (
					<div key={`${m.sentAt}-${m.playerId}`}>
						<span className={m.playerId === currentPlayerId ? "font-bold" : "text-gray-600"}>
							{m.playerName}:
						</span>{" "}
						<span className="break-words">{m.text}</span>
					</div>
				))}
			</div>
			{open ? (
				<input
					ref={inputRef}
					type="text"
					value={value}
					maxLength={300}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							if (value.trim()) onSend(value);
							setValue("");
							onClose();
						} else if (e.key === "Escape") {
							setValue("");
							onClose();
						}
					}}
					onBlur={onClose}
					className="mt-2 w-full border border-black px-2 py-1 text-xs font-mono"
					placeholder="chat... (enter to send, esc to close)"
				/>
			) : (
				<div className="mt-1 text-xs text-gray-400">press enter to chat</div>
			)}
		</div>
	);
}
