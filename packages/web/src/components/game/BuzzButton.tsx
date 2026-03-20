interface Props {
	onBuzz: () => void;
	disabled: boolean;
}

export function BuzzButton({ onBuzz, disabled }: Props) {
	return (
		<button
			type="button"
			onClick={onBuzz}
			disabled={disabled}
			className={
				"w-full py-3 border border-black text-sm font-mono " +
				(disabled ? "text-gray-400 cursor-not-allowed" : "hover:bg-black hover:text-white cursor-pointer")
			}
		>
			BUZZ [space]
		</button>
	);
}
