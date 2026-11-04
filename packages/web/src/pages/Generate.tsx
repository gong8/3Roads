import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DIFFICULTIES, difficultyLabel, ModelSelect, STYLE_PLACEHOLDER, useModelChoice } from "../components/ModelSelect";
import { useOpenRouterCredits } from "./Settings";
import { type GenerateRun, useGenerate } from "../hooks/useGenerate";
import { formatCost } from "../lib/format";

/** Matches MAX_SET_QUESTIONS on the server, which writes large sets in batches. */
const MAX_TOSSUPS = 50;

/** Matches MAX_PACKETS on the server. */
const MAX_PACKETS = 5;

function phaseText(run: GenerateRun): string {
  if (run.status === "complete") return "done";
  if (run.status === "error") return `error: ${run.error}`;
  if (run.tossupCount === 0 && run.bonusCount === 0) return "generating...";
  if (run.tossupCount < run.targetTossups) return `writing tossups (${run.tossupCount}/${run.targetTossups})`;
  if (run.bonusCount < run.targetBonuses) return `writing bonuses (${run.bonusCount}/${run.targetBonuses})`;
  return "finishing...";
}

function RunRow({ run, onDismiss }: { run: GenerateRun; onDismiss: () => void }) {
  const target = run.targetTossups + run.targetBonuses;
  const progress = target > 0 ? Math.min(100, ((run.tossupCount + run.bonusCount) / target) * 100) : 0;
  return (
    <li className="mb-4">
      <div className="flex justify-between gap-3 text-sm">
        <span className="font-bold truncate">{run.name}</span>
        {run.status !== "generating" && (
          <button type="button" onClick={onDismiss} className="text-gray-400 hover:text-black">dismiss</button>
        )}
      </div>
      <div className={`mb-1 text-sm ${run.status === "error" ? "text-red-600" : "text-gray-600"}`}>
        {phaseText(run)}
        {run.status === "generating" && target > 0 && <span className="ml-2">({Math.round(progress)}%)</span>}
        {run.status === "complete" && (
          <>
            <Link to={`/sets/${run.setId}`} className="ml-3 underline text-black">view set</Link>
            {run.cost != null && <span className="ml-3">cost: {formatCost(run.cost)}</span>}
          </>
        )}
      </div>
      {run.status === "generating" && target > 0 && (
        <div className="h-1 bg-gray-200">
          <div className="h-1 bg-black transition-all duration-300" style={{ width: `${Math.round(progress)}%` }} />
        </div>
      )}
    </li>
  );
}

export function Generate() {
  const [theme, setTheme] = useState("");
  const [style, setStyle] = useState("");
  const [tossupCountStr, setTossupCountStr] = useState("5");
  const tossupCount = Math.min(MAX_TOSSUPS, Math.max(1, parseInt(tossupCountStr, 10) || 1));
  const [pictureCountStr, setPictureCountStr] = useState("0");
  const pictureCount = Math.min(tossupCount, Math.max(0, parseInt(pictureCountStr, 10) || 0));
  const [packetCountStr, setPacketCountStr] = useState("1");
  const packetCount = Math.min(MAX_PACKETS, Math.max(1, parseInt(packetCountStr, 10) || 1));
  const [includeBonuses, setIncludeBonuses] = useState(true);
  const [difficulty, setDifficulty] = useState("Regular High School");
  const modelChoice = useModelChoice();
  const { model, needsChatGPT } = modelChoice;
  const { refetch: refetchCredits } = useOpenRouterCredits();
  const { runs, start, dismiss } = useGenerate();
  // Only while the request is in flight: once the server has the sets, the form is free for the next one
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!theme.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await start({
        theme: theme.trim(),
        tossupCount,
        bonusCount: includeBonuses ? tossupCount : 0,
        difficulty,
        model,
        pictureCount,
        style: style.trim(),
        packetCount,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Each finished run has spent credits: show the new balance
  const finishedCount = runs.filter((r) => r.status !== "generating").length;
  useEffect(() => {
    if (finishedCount > 0) refetchCredits();
  }, [finishedCount, refetchCredits]);

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
            maxLength={80}
            disabled={submitting}
          />
        </div>
        <div className="mb-3">
          <label className="block mb-1">
            question style <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            className="border border-black px-2 py-1 w-full font-mono"
            placeholder={STYLE_PLACEHOLDER}
            maxLength={300}
            rows={2}
            disabled={submitting}
          />
        </div>
        <div className="mb-3">
          <label className="block mb-1">difficulty</label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className="border border-black px-2 py-1 font-mono"
            disabled={submitting}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>{difficultyLabel(d)}</option>
            ))}
          </select>
        </div>
        <div className="mb-3">
          <label className="block mb-1">model</label>
          <ModelSelect choice={modelChoice} disabled={submitting} />
        </div>
        <div className="mb-3">
          <label className="block mb-1">tossups</label>
          <input
            type="number"
            value={tossupCountStr}
            onChange={(e) => setTossupCountStr(e.target.value)}
            onBlur={() => setTossupCountStr(String(tossupCount))}
            min={1}
            max={MAX_TOSSUPS}
            className="border border-black px-2 py-1 w-20 font-mono"
            disabled={submitting}
          />
        </div>
        <div className="mb-3">
          <label className="block mb-1 text-sm">
            picture questions{" "}
            <span className="text-gray-400 font-normal">(wikipedia images, 0–{tossupCount})</span>
          </label>
          <input
            type="number"
            value={pictureCountStr}
            onChange={(e) => setPictureCountStr(e.target.value)}
            onBlur={() => setPictureCountStr(String(pictureCount))}
            min={0}
            max={tossupCount}
            className="border border-black px-2 py-1 w-20 font-mono"
            disabled={submitting}
          />
        </div>
        <div className="mb-3">
          <label className="block mb-1 text-sm">
            packets{" "}
            <span className="text-gray-400 font-normal">(1–{MAX_PACKETS}, each a separate set with no repeated answers)</span>
          </label>
          <input
            type="number"
            value={packetCountStr}
            onChange={(e) => setPacketCountStr(e.target.value)}
            onBlur={() => setPacketCountStr(String(packetCount))}
            min={1}
            max={MAX_PACKETS}
            className="border border-black px-2 py-1 w-20 font-mono"
            disabled={submitting}
          />
        </div>
        <div className="mb-3">
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeBonuses}
              onChange={(e) => setIncludeBonuses(e.target.checked)}
              disabled={submitting}
            />
            include bonuses ({tossupCount}, matching tossup count)
          </label>
        </div>
        <button
          type="submit"
          disabled={submitting || !theme.trim() || !model || needsChatGPT}
          className="border border-black px-3 py-1 disabled:text-gray-400 disabled:border-gray-400"
        >
          {packetCount > 1 ? `generate ${packetCount} packets` : "generate"}
        </button>
      </form>

      <p className="mb-4 text-gray-600">generated sets join the public pool; you can make yours private from browse.</p>
      {error && <p className="text-red-600 mb-4">error: {error}</p>}

      {runs.length > 0 && (
        <div className="border-t border-black pt-4">
          <ul>
            {runs.map((run) => (
              <RunRow key={run.setId} run={run} onDismiss={() => dismiss(run.setId)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
