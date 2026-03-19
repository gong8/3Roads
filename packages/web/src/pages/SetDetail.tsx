import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSet } from "../hooks/useSets";
import { TossupBlock } from "../components/TossupBlock";
import { BonusBlock } from "../components/BonusBlock";

export function SetDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: set, isLoading } = useSet(id!);
  const [mode, setMode] = useState<"review" | "practice">("review");
  const [revealedTossups, setRevealedTossups] = useState<Set<string>>(new Set());
  const [revealedBonuses, setRevealedBonuses] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("");

  if (isLoading) return <p>loading...</p>;
  if (!set) return <p>set not found. <Link to="/" className="underline">back</Link></p>;

  const categories = [...new Set([
    ...(set.tossups?.map((t) => t.category) ?? []),
    ...(set.bonuses?.map((b) => b.category) ?? []),
  ])].sort();

  const filteredTossups = categoryFilter
    ? set.tossups?.filter((t) => t.category === categoryFilter) ?? []
    : set.tossups ?? [];

  const filteredBonuses = categoryFilter
    ? set.bonuses?.filter((b) => b.category === categoryFilter) ?? []
    : set.bonuses ?? [];

  return (
    <div>
      <div className="mb-4">
        <Link to="/" className="underline">back</Link>
        <h1 className="text-lg font-bold mt-2">{set.name}</h1>
        <p className="text-gray-500">{set.theme}</p>
      </div>

      <div className="flex gap-4 mb-4 border-b border-black pb-2">
        <button
          type="button"
          onClick={() => setMode("review")}
          className={mode === "review" ? "underline" : ""}
        >
          review
        </button>
        <button
          type="button"
          onClick={() => { setMode("practice"); setRevealedTossups(new Set()); setRevealedBonuses(new Set()); }}
          className={mode === "practice" ? "underline" : ""}
        >
          practice
        </button>
        {categories.length > 1 && (
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="border border-black px-1 ml-auto font-mono text-sm"
          >
            <option value="">all categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>

      {filteredTossups.length > 0 && (
        <div className="mb-6">
          <h2 className="font-bold mb-2">tossups ({filteredTossups.length})</h2>
          {filteredTossups.map((t) => (
            <TossupBlock
              key={t.id}
              {...t}
              showAnswer={mode === "review" || revealedTossups.has(t.id)}
              onToggleAnswer={() => setRevealedTossups((s) => new Set(s).add(t.id))}
            />
          ))}
        </div>
      )}

      {filteredBonuses.length > 0 && (
        <div>
          <h2 className="font-bold mb-2">bonuses ({filteredBonuses.length})</h2>
          {filteredBonuses.map((b) => (
            <BonusBlock
              key={b.id}
              {...b}
              showAnswers={mode === "review" || revealedBonuses.has(b.id)}
              onToggleAnswers={() => setRevealedBonuses((s) => new Set(s).add(b.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
