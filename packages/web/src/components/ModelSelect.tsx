import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useChatGPTStatus, useOpenRouterCredits } from "../pages/Settings";
import { apiGet } from "../lib/api";
import { formatCost } from "../lib/format";

export const DIFFICULTIES = [
  "Middle School",
  "Easy High School",
  "Regular High School",
  "Hard High School",
  "Easy College",
  "Regular College",
  "Hard College",
  "Open",
];

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
export function isOpenRouterModel(model: string): boolean {
  return model.includes("/");
}

/** The models this user can generate with, and which one they've picked. */
export function useModelChoice() {
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
  return { model, setModel, modelList, connected, needsChatGPT };
}

export type ModelChoice = ReturnType<typeof useModelChoice>;

/** Model dropdown, with the OpenRouter balance or a prompt to connect ChatGPT underneath. */
export function ModelSelect({ choice, disabled, className = "" }: { choice: ModelChoice; disabled?: boolean; className?: string }) {
  const { model, setModel, modelList, connected, needsChatGPT } = choice;
  const { data: credits } = useOpenRouterCredits();
  return (
    <>
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className={`border border-black px-2 py-1 font-mono ${className}`}
        disabled={disabled}
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
    </>
  );
}
