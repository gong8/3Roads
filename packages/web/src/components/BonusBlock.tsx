interface BonusPart {
  partNum: number;
  text: string;
  answer: string;
  value: number;
}

interface Props {
  leadin: string;
  parts: BonusPart[];
  category: string;
  subcategory: string;
  difficulty: string;
  showAnswers?: boolean;
  onToggleAnswers?: () => void;
}

export function BonusBlock({ leadin, parts, category, subcategory, difficulty, showAnswers = true, onToggleAnswers }: Props) {
  const sorted = [...parts].sort((a, b) => a.partNum - b.partNum);

  return (
    <div className="border border-black p-3 mb-3">
      <div className="text-xs text-gray-500 mb-1">{category} / {subcategory} — {difficulty}</div>
      <p className="mb-2">{leadin}</p>
      {sorted.map((part) => (
        <div key={part.partNum} className="ml-4 mb-2">
          <p>[{part.value}] {part.text}</p>
          {showAnswers ? (
            <p className="font-bold">ANSWER: {part.answer}</p>
          ) : null}
        </div>
      ))}
      {!showAnswers && (
        <button type="button" className="text-gray-500 underline" onClick={onToggleAnswers}>[show answers]</button>
      )}
    </div>
  );
}
