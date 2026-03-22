import { useState } from "react";
import { Link } from "react-router-dom";
import { useGenerate } from "../hooks/useGenerate";

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
  const [model, setModel] = useState("haiku");
  const {
    isGenerating, error, setId, status,
    tossupCount: savedTossups, bonusCount: savedBonuses,
    targetTossups, targetBonuses,
    generate,
  } = useGenerate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!theme.trim()) return;
    generate(theme.trim(), tossupCount, bonusCount, difficulty, model);
  };

  const totalTarget = targetTossups + targetBonuses;
  const totalSaved = savedTossups + savedBonuses;
  const isDone = status === "complete";

  let progress = 0;
  if (totalTarget > 0) {
    progress = (totalSaved / totalTarget) * 100;
  }

  const phaseText = isGenerating
    ? savedTossups === 0 && savedBonuses === 0
      ? "generating..."
      : savedTossups < targetTossups
        ? `writing tossups (${savedTossups}/${targetTossups})`
        : savedBonuses < targetBonuses
          ? `writing bonuses (${savedBonuses}/${targetBonuses})`
          : "finishing..."
    : isDone ? "done" : status === "error" ? "error" : "";

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
            disabled={isGenerating}
          />
        </div>
        <div className="mb-3">
          <label className="block mb-1">difficulty</label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className="border border-black px-2 py-1 font-mono"
            disabled={isGenerating}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>{d.toLowerCase()}</option>
            ))}
          </select>
        </div>
        <div className="mb-3">
          <label className="block mb-1">model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="border border-black px-2 py-1 font-mono"
            disabled={isGenerating}
          >
            <option value="haiku">Claude 3.5 Haiku (Lower Quality, 10x Cheaper)</option>
            <option value="sonnet">Claude 3.5 Sonnet (Premium Quality)</option>
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
              disabled={isGenerating}
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
              disabled={isGenerating}
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={isGenerating || !theme.trim()}
          className="border border-black px-3 py-1 disabled:text-gray-400 disabled:border-gray-400"
        >
          generate
        </button>
      </form>

      {error && <p className="text-red-600 mb-4">error: {error}</p>}

      {(isGenerating || isDone) && (
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
        </div>
      )}
    </div>
  );
}
