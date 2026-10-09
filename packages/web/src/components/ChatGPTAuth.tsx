import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../lib/api";

export interface AuthStatus {
  signedIn: boolean;
  email?: string;
}

// Keeps the access token at least 50 minutes from expiry, so game sockets
// (which read it once at connect) get a token that outlasts most games.
export function useChatGPTStatus() {
  return useQuery({
    queryKey: ["chatgpt-status"],
    queryFn: () => apiGet<AuthStatus>("/auth/chatgpt/status?minValid=3000"),
    refetchInterval: 10 * 60_000,
  });
}

export function ChatGPTAuth() {
  const qc = useQueryClient();
  const { data } = useChatGPTStatus();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["chatgpt-status"] });

  const start = async () => {
    setError(null);
    const { url } = await apiPost<{ url: string }>("/auth/chatgpt/start");
    window.open(url, "_blank", "noopener");
    setPasting(true);
  };

  const complete = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await apiPost("/auth/chatgpt/complete", { url: pasted });
      setPasting(false);
      setPasted("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (data?.signedIn) {
    return (
      <span className="ml-auto text-gray-600">
        {data.email ?? "chatgpt"}{" "}
        <button type="button" className="underline" onClick={() => apiPost("/auth/chatgpt/logout").then(refresh)}>
          sign out
        </button>
      </span>
    );
  }

  if (!pasting) {
    return (
      <button type="button" className="ml-auto underline" onClick={start}>
        sign in with chatgpt
      </button>
    );
  }

  return (
    <form onSubmit={complete} className="ml-auto flex flex-col items-end gap-1">
      <span className="text-gray-600 text-xs">
        after approving, the tab lands on a 127.0.0.1 page that won't load. paste its address:
      </span>
      <span className="flex gap-2">
        <input
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="http://127.0.0.1:1455/auth/callback?code=…"
          className="border border-black px-2 py-0.5 w-72 font-mono text-xs"
        />
        <button type="submit" className="border border-black px-2" disabled={!pasted.trim()}>
          done
        </button>
        <button type="button" className="underline" onClick={() => setPasting(false)}>
          cancel
        </button>
      </span>
      {error && <span className="text-red-600 text-xs">{error}</span>}
    </form>
  );
}
