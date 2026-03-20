import { useState } from "react";
import { Link } from "react-router-dom";
import { useGenerationStream } from "../hooks/useGenerationStream";

export function Generate() {
  const [theme, setTheme] = useState("");
  const [tossupCount, setTossupCount] = useState(5);
  const [bonusCount, setBonusCount] = useState(5);
  const {
    isStreaming, content, error, setId,
    savedTossups, savedBonuses, targetTossups, targetBonuses,
    generate, stop,
  } = useGenerationStream();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!theme.trim()) return;
    console.log("[3roads:ui]", "form submitted:", { theme: theme.trim(), tossupCount, bonusCount });
    generate(theme.trim(), tossupCount, bonusCount);
  };

  const totalTarget = targetTossups + targetBonuses;
  const totalSaved = savedTossups + savedBonuses;
  const isDone = !isStreaming && totalSaved > 0;

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
            {isStreaming ? "generating" : "done"} — tossups: {savedTossups}/{targetTossups}, bonuses: {savedBonuses}/{targetBonuses}
            {totalTarget > 0 && (
              <span className="ml-2">({Math.round((totalSaved / totalTarget) * 100)}%)</span>
            )}
          </div>

          {totalTarget > 0 && (
            <div className="mb-4 h-1 bg-gray-200">
              <div
                className="h-1 bg-black transition-all duration-300"
                style={{ width: `${Math.round((totalSaved / totalTarget) * 100)}%` }}
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
