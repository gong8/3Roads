interface Props {
  question: string;
  answer: string;
  powerMarkIndex: number | null;
  category: string;
  subcategory: string;
  difficulty: string;
  showAnswer?: boolean;
  onToggleAnswer?: () => void;
}

export function TossupBlock({ question, answer, powerMarkIndex, category, subcategory, difficulty, showAnswer = true, onToggleAnswer }: Props) {
  const displayQuestion = powerMarkIndex != null
    ? question.slice(0, powerMarkIndex) + "(*) " + question.slice(powerMarkIndex)
    : question;

  return (
    <div className="border border-black p-3 mb-3">
      <div className="text-xs text-gray-500 mb-1">{category} / {subcategory} — {difficulty}</div>
      <p className="mb-2 whitespace-pre-wrap">{displayQuestion}</p>
      {showAnswer ? (
        <p className="font-bold">ANSWER: {answer}</p>
      ) : (
        <button type="button" className="text-gray-500 underline" onClick={onToggleAnswer}>[show answer]</button>
      )}
    </div>
  );
}
