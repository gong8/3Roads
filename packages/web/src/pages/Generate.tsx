import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useChatGPTStatus, useOpenRouterCredits } from "./Settings";
import { useGenerate } from "../hooks/useGenerate";
import { apiGet } from "../lib/api";
import { formatCost } from "../lib/format";

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

/** Matches MAX_SET_QUESTIONS on the server, which writes large sets in batches. */
const MAX_TOSSUPS = 50;

interface ModelList {
  default: string;
  chatgptConnected: boolean;
  chatgptDefault: string;
  /** The user's ChatGPT plan models; empty until connected */
  models: { slug: string; name: string }[];
  /** Server-paid OpenRouter models; empty when the server has no key */
  openrouter: { slug: string; name: string }[];
}

/** OpenRouter slugs are "vendor/model"; ChatGPT plan slugs never contain a slash. */
function isOpenRouterModel(model: string): boolean {
  return model.includes("/");
}

export function Generate() {
  const [theme, setTheme] = useState("");
  const [tossupCountStr, setTossupCountStr] = useState("5");
  const tossupCount = Math.min(MAX_TOSSUPS, Math.max(1, parseInt(tossupCountStr, 10) || 1));
  const [pictureCountStr, setPictureCountStr] = useState("0");
  const pictureCount = Math.min(tossupCount, Math.max(0, parseInt(pictureCountStr, 10) || 0));
  const [includeBonuses, setIncludeBonuses] = useState(true);
  const [difficulty, setDifficulty] = useState("Regular High School");
  const { data: chatgpt } = useChatGPTStatus();
  const connected = chatgpt?.connected === true;
  const { data: modelList } = useQuery({
    // Keyed on the connection so connecting in settings refreshes the list
    queryKey: ["chatgpt-models", connected],
    queryFn: () => apiGet<ModelList>("/me/models"),
  });
  const [chosenModel, setModel] = useState<string | null>(null);
  const model = chosenModel ?? modelList?.default ?? "";
  // OpenRouter models run on the server's key; ChatGPT models need the user's own plan
  const needsChatGPT = model !== "" && !isOpenRouterModel(model) && !connected;
  const { data: credits, refetch: refetchCredits } = useOpenRouterCredits();
  const {
    isGenerating, error, setId, status,
    tossupCount: savedTossups, bonusCount: savedBonuses,
    targetTossups, targetBonuses, cost,
    generate,
  } = useGenerate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!theme.trim()) return;
    generate(theme.trim(), tossupCount, includeBonuses ? tossupCount : 0, difficulty, model, pictureCount);
  };

  const totalTarget = targetTossups + targetBonuses;
  const totalSaved = savedTossups + savedBonuses;
  const isDone = status === "complete";

  // A finished run has spent credits: show the new balance
  useEffect(() => {
    if (isDone) refetchCredits();
  }, [isDone, refetchCredits]);

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
            maxLength={80}
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
            {modelList && modelList.openrouter.length > 0 && (
              <optgroup label="openrouter">
                {modelList.openrouter.map((m) => (
                  <option key={m.slug} value={m.slug}>{m.name}</option>
                ))}
              </optgroup>
            )}
            {modelList && (
              <optgroup label={connected ? "chatgpt (your plan)" : "chatgpt (needs your account)"}>
                {!modelList.models.some((m) => m.slug === modelList.chatgptDefault) && (
                  <option value={modelList.chatgptDefault}>
                    {modelList.chatgptDefault}{connected ? "" : " — connect chatgpt"}
                  </option>
                )}
                {modelList.models.map((m) => (
                  <option key={m.slug} value={m.slug}>{m.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {isOpenRouterModel(model) && credits?.enabled && credits.remaining != null && (
            <p className="mt-1 text-gray-600">openrouter credits: {formatCost(credits.remaining)} left</p>
          )}
          {needsChatGPT && (
            <p className="mt-1 text-gray-600">
              this model runs on your own chatgpt plus or pro plan.{" "}
              <Link to="/settings" className="underline">connect chatgpt</Link>
              {modelList && modelList.openrouter.length > 0 && " or pick an openrouter model"}.
            </p>
          )}
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
            disabled={isGenerating}
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
            disabled={isGenerating}
          />
        </div>
        <div className="mb-3">
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeBonuses}
              onChange={(e) => setIncludeBonuses(e.target.checked)}
              disabled={isGenerating}
            />
            include bonuses ({tossupCount}, matching tossup count)
          </label>
        </div>
        <button
          type="submit"
          disabled={isGenerating || !theme.trim() || !model || needsChatGPT}
          className="border border-black px-3 py-1 disabled:text-gray-400 disabled:border-gray-400"
        >
          generate
        </button>
      </form>

      <p className="mb-4 text-gray-600">generated sets join the public pool; you can make yours private from browse.</p>
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
              {cost != null && <span className="ml-3 text-sm text-gray-600">cost: {formatCost(cost)}</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
