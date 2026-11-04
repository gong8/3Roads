import { useState } from "react";
import { Link } from "react-router-dom";
import { ModelSelect, useModelChoice } from "../components/ModelSelect";
import { useCreateLearnPack, useDeleteLearnPack, useLearnPacks, useUpdateLearnPack } from "../hooks/useLearn";
import { formatCost } from "../lib/format";

/** Match MAX_ANSWERS and MAX_CARDS_PER_ANSWER on the server. */
const MAX_ANSWERS = 40;
const MAX_CARDS_PER_ANSWER = 30;

const clamp = (s: string, max: number) => Math.min(max, Math.max(1, parseInt(s, 10) || 1));

function NewPackForm() {
  const [topic, setTopic] = useState("");
  const [promptKind, setPromptKind] = useState("");
  const [answerKind, setAnswerKind] = useState("");
  const [answerCountStr, setAnswerCountStr] = useState("20");
  const [cardsPerAnswerStr, setCardsPerAnswerStr] = useState("15");
  const answerCount = clamp(answerCountStr, MAX_ANSWERS);
  const cardsPerAnswer = clamp(cardsPerAnswerStr, MAX_CARDS_PER_ANSWER);
  const modelChoice = useModelChoice();
  const create = useCreateLearnPack();

  const ready = topic.trim() && promptKind.trim() && answerKind.trim() && modelChoice.model && !modelChoice.needsChatGPT;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    create.mutate(
      { topic: topic.trim(), promptKind: promptKind.trim(), answerKind: answerKind.trim(), answerCount, cardsPerAnswer, model: modelChoice.model },
      { onSuccess: () => setTopic("") },
    );
  };

  const input = "border border-black px-2 py-1 font-mono";
  return (
    <form onSubmit={submit} className="mb-8">
      <div className="mb-3">
        <label className="block mb-1">topic</label>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={80} className={`${input} w-full`} placeholder="e.g. European paintings, Napoleonic Wars, Romantic composers" />
      </div>
      <div className="mb-3 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block mb-1">you're shown a</label>
          <input value={promptKind} onChange={(e) => setPromptKind(e.target.value)} maxLength={40} className={`${input} w-40`} placeholder="painting" />
        </div>
        <span className="pb-1">→</span>
        <div>
          <label className="block mb-1">you name its</label>
          <input value={answerKind} onChange={(e) => setAnswerKind(e.target.value)} maxLength={40} className={`${input} w-40`} placeholder="artist" />
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-3 items-end">
        <div>
          <label className="block mb-1">answers <span className="text-gray-400">(1–{MAX_ANSWERS})</span></label>
          <input type="number" value={answerCountStr} min={1} max={MAX_ANSWERS} onChange={(e) => setAnswerCountStr(e.target.value)} onBlur={() => setAnswerCountStr(String(answerCount))} className={`${input} w-20`} />
        </div>
        <span className="pb-1">×</span>
        <div>
          <label className="block mb-1">cards each <span className="text-gray-400">(up to {MAX_CARDS_PER_ANSWER})</span></label>
          <input type="number" value={cardsPerAnswerStr} min={1} max={MAX_CARDS_PER_ANSWER} onChange={(e) => setCardsPerAnswerStr(e.target.value)} onBlur={() => setCardsPerAnswerStr(String(cardsPerAnswer))} className={`${input} w-20`} />
        </div>
        <span className="pb-1 text-gray-600">≈ {answerCount * cardsPerAnswer} cards</span>
      </div>
      <div className="mb-3">
        <label className="block mb-1">model</label>
        <ModelSelect choice={modelChoice} disabled={create.isPending} />
      </div>
      <button type="submit" disabled={!ready || create.isPending} className="border border-black px-3 py-1 disabled:text-gray-400 disabled:border-gray-400">
        {create.isPending ? "starting..." : "generate pack"}
      </button>
      {create.error && <p className="text-red-600 mt-2">error: {create.error.message}</p>}
    </form>
  );
}

export function Learn() {
  const { data: packs, isLoading } = useLearnPacks();
  const update = useUpdateLearnPack();
  const remove = useDeleteLearnPack();

  return (
    <div>
      <NewPackForm />
      <div className="border-t border-black pt-4">
        {isLoading ? (
          <p>loading...</p>
        ) : !packs?.length ? (
          <p className="text-gray-500">no packs yet</p>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-black">
                <th className="py-1 pr-4">pack</th>
                <th className="py-1 text-center px-4">cards</th>
                <th className="py-1 text-right px-4">cost</th>
                <th className="py-1 w-16" />
              </tr>
            </thead>
            <tbody>
              {packs.map((p) => (
                <tr key={p.id} className="border-b border-gray-300">
                  <td className="py-1 pr-4 break-words">
                    {p.status === "complete" ? <Link to={`/learn/${p.id}`} className="underline">{p.name}</Link> : p.name}
                    {p.isPrivate && <span className="ml-2 text-xs text-gray-500">private</span>}
                    {p.status === "generating" && <span className="ml-2 text-xs text-gray-500 italic">generating…</span>}
                    {p.status === "error" && <span className="ml-2 text-xs text-red-600">{p.error ?? "failed"}</span>}
                    {p.status === "complete" && p.error && <span className="ml-2 text-xs text-gray-500">({p.error})</span>}
                  </td>
                  <td className="py-1 text-center px-4">{p.cardCount ?? 0}</td>
                  <td className="py-1 text-right px-4">{p.cost != null ? formatCost(p.cost) : "—"}</td>
                  <td className="py-1 text-right whitespace-nowrap">
                    {p.mine && (
                      <>
                        <button type="button" onClick={() => update.mutate({ id: p.id, isPrivate: !p.isPrivate })} className="text-xs text-gray-500 hover:text-black mr-2" title={p.isPrivate ? "make public" : "make private"}>
                          {p.isPrivate ? "share" : "hide"}
                        </button>
                        <button type="button" onClick={() => confirm(`Delete "${p.name}"?`) && remove.mutate(p.id)} className="text-xs text-gray-500 hover:text-black">
                          delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-4 text-gray-600">packs are shared with everyone unless you hide them.</p>
      </div>
    </div>
  );
}
