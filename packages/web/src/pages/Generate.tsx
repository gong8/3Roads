import { useState } from "react";
import { Link } from "react-router-dom";
import { useGenerationStream } from "../hooks/useGenerationStream";

const DIFFICULTIES = [
  "Middle School",
  "Easy High School",
  "Regular High School",
  "Hard High School",
  "Easy College",
  "Regular College",
  "Hard College",
  "Open",
];

export function Generate() {
  const [theme, setTheme] = useState("");
  const [tossupCount, setTossupCount] = useState(5);
  const [bonusCount, setBonusCount] = useState(5);
  const [difficulty, setDifficulty] = useState("Regular High School");
  const {
    isStreaming, content, error, setId,
    savedTossups, savedBonuses, targetTossups, targetBonuses,
    phase, generate, stop,
  } = useGenerationStream();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!theme.trim()) return;
    console.log("[3roads:ui]", "form submitted:", { theme: theme.trim(), tossupCount, bonusCount, difficulty });
    generate(theme.trim(), tossupCount, bonusCount, difficulty);
  };

  const totalTarget = targetTossups + targetBonuses;
  const totalSaved = savedTossups + savedBonuses;
  const isDone = !isStreaming && totalSaved > 0;

  // Count ANSWER: markers in content for writing progress
  const answerCount = (content.match(/ANSWER:/g) || []).length;
  const writtenTossups = Math.min(answerCount, targetTossups);
  const writtenBonuses = answerCount > targetTossups
    ? Math.min(Math.floor((answerCount - targetTossups) / 3), targetBonuses)
    : 0;

  // Compute progress percentage based on phase
  let progress = 0;
  if (totalTarget > 0) {
    if (phase === "writing_tossups") {
      progress = (writtenTossups / totalTarget) * 100;
    } else if (phase === "saving_tossups") {
      progress = (targetTossups / totalTarget) * 100;
    } else if (phase === "writing_bonuses") {
      progress = ((savedTossups + writtenBonuses) / totalTarget) * 100;
    } else if (phase === "saving_bonuses") {
      progress = 100;
    } else if (isDone) {
      progress = 100;
    }
  }

  const phaseText = isStreaming
    ? phase === "writing_tossups" ? `writing tossups (${writtenTossups}/${targetTossups})`
    : phase === "saving_tossups" ? "saving tossups..."
    : phase === "writing_bonuses" ? `writing bonuses (${writtenBonuses}/${targetBonuses})`
    : phase === "saving_bonuses" ? "saving bonuses..."
    : "generating..."
    : isDone ? "done" : "";

  return (
    <div>
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="mb-3">
          <label className="block mb-1">theme</label>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="border border-black px-2 py-1 w-full font-mono"
            placeholder="e.g. American Civil War, Organic Chemistry"
            disabled={isStreaming}
          />
        </div>
        <div className="mb-3">
          <label className="block mb-1">difficulty</label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className="border border-black px-2 py-1 font-mono"
            disabled={isStreaming}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>{d.toLowerCase()}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-4 mb-3">
          <div>
            <label className="block mb-1">tossups</label>
            <input
              type="number"
              value={tossupCount}
              onChange={(e) => setTossupCount(Number(e.target.value))}
              min={0}
              max={20}
              className="border border-black px-2 py-1 w-20 font-mono"
              disabled={isStreaming}
            />
          </div>
          <div>
            <label className="block mb-1">bonuses</label>
            <input
              type="number"
              value={bonusCount}
              onChange={(e) => setBonusCount(Number(e.target.value))}
              min={0}
              max={20}
              className="border border-black px-2 py-1 w-20 font-mono"
              disabled={isStreaming}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isStreaming || !theme.trim()}
            className="border border-black px-3 py-1 disabled:text-gray-400 disabled:border-gray-400"
          >
            generate
          </button>
          {isStreaming && (
            <button
              type="button"
              onClick={stop}
              className="border border-black px-3 py-1"
            >
              stop
            </button>
          )}
        </div>
      </form>

      {error && <p className="text-red-600 mb-4">error: {error}</p>}

      {(isStreaming || isDone) && (
        <div className="border-t border-black pt-4">
          <div className="mb-3 text-sm text-gray-600">
            {phaseText}
            {totalTarget > 0 && (
              <span className="ml-2">({Math.round(progress)}%)</span>
            )}
          </div>

          {totalTarget > 0 && (
            <div className="mb-4 h-1 bg-gray-200">
              <div
                className="h-1 bg-black transition-all duration-300"
                style={{ width: `${Math.round(progress)}%` }}
              />
            </div>
          )}

          {isDone && setId && (
            <p className="mb-4">
              <Link to={`/sets/${setId}`} className="underline">view set</Link>
            </p>
          )}

          {content && (
            <pre className="whitespace-pre-wrap font-mono text-sm">{content}</pre>
          )}
        </div>
      )}
    </div>
  );
}
