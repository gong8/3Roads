import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiDelete, apiGet, apiPost } from "../lib/api";

export interface ChatGPTStatus {
  connected: boolean;
  email?: string;
}

interface GameResult {
  id: string;
  setName: string;
  score: number;
  powers: number;
  tens: number;
  negs: number;
  createdAt: string;
}

export function useChatGPTStatus() {
  return useQuery({ queryKey: ["chatgpt"], queryFn: () => apiGet<ChatGPTStatus>("/me/chatgpt") });
}

export function Settings() {
  const qc = useQueryClient();
  const { data: chatgpt } = useChatGPTStatus();
  const { data: games } = useQuery({ queryKey: ["games"], queryFn: () => apiGet<GameResult[]>("/me/games") });
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["chatgpt"] });
    qc.invalidateQueries({ queryKey: ["chatgpt-models"] });
  };

  const start = async () => {
    setError(null);
    const { url } = await apiPost<{ url: string }>("/me/chatgpt/start");
    window.open(url, "_blank", "noopener");
    setPasting(true);
  };

  const complete = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiPost("/me/chatgpt/complete", { url: pasted });
      setPasting(false);
      setPasted("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      <h2 className="font-bold mb-2">chatgpt</h2>
      <p className="mb-3 text-gray-600">
        generation and fuzzy answer judging run on your own chatgpt plus or pro plan.
      </p>
      {chatgpt?.connected ? (
        <p className="mb-6">
          connected{chatgpt.email ? ` as ${chatgpt.email}` : ""}.{" "}
          <button type="button" className="underline" onClick={() => apiDelete("/me/chatgpt").then(refresh)}>
            disconnect
          </button>
        </p>
      ) : !pasting ? (
        <p className="mb-6">
          <button type="button" className="border border-black px-3 py-1" onClick={start}>
            connect chatgpt
          </button>
        </p>
      ) : (
        <form onSubmit={complete} className="mb-6">
          <p className="mb-2 text-gray-600">
            approve in the new tab. it then lands on a 127.0.0.1 page that won't load; copy that page's address and paste it here:
          </p>
          <div className="flex gap-2">
            <input
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="http://127.0.0.1:1455/auth/callback?code=…"
              className="border border-black px-2 py-1 w-full font-mono"
            />
            <button type="submit" className="border border-black px-3" disabled={!pasted.trim()}>
              done
            </button>
            <button type="button" className="underline" onClick={() => setPasting(false)}>
              cancel
            </button>
          </div>
          {error && <p className="text-red-600 mt-2">{error}</p>}
        </form>
      )}

      <h2 className="font-bold mb-2">recent games</h2>
      {!games?.length ? (
        <p className="text-gray-600">none yet.</p>
      ) : (
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-black">
              <th className="py-1">set</th>
              <th className="py-1 text-right">score</th>
              <th className="py-1 text-right">15/10/-5</th>
              <th className="py-1 text-right">date</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id} className="border-b border-gray-300">
                <td className="py-1">{g.setName}</td>
                <td className="py-1 text-right">{g.score}</td>
                <td className="py-1 text-right">{g.powers}/{g.tens}/{g.negs}</td>
                <td className="py-1 text-right">{new Date(g.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
