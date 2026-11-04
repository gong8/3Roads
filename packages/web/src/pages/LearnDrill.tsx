import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AnswerText } from "../components/AnswerText";
import { judgeCard, type LearnCard, useLearnPack, type Verdict } from "../hooks/useLearn";

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The answer without markup, for grouping cards: "Vincent van {Gogh}" → "Vincent van Gogh". */
const plain = (answer: string) => answer.replace(/\s*\[[^\]]*\]/g, "").replace(/[{}]/g, "").trim();

const DEFAULT_POOL_SIZE = 20;
const DEFAULT_TIMES_NEEDED = 2;

/** A card in the working pool, with how many times in a row it's been answered right. */
interface PoolCard {
  card: LearnCard;
  streak: number;
}

/**
 * The drill: a pool of cards is cycled at random; a card leaves once answered right
 * `timesNeeded` times in a row (a miss resets it), and the next unseen card takes its place.
 */
interface Session {
  pool: PoolCard[];
  /** Unseen cards, waiting for a slot in the pool */
  queue: LearnCard[];
  current: PoolCard | null;
  learned: number;
  total: number;
  attempts: number;
  right: number;
  /** Cards missed at least once, with the last wrong answer, for the end screen */
  missed: Map<string, { card: LearnCard; given: string }>;
}

/** Pick the next card, avoiding the one just shown when there's any other choice. */
function pickNext(pool: PoolCard[], lastId?: string): PoolCard | null {
  if (pool.length === 0) return null;
  const others = pool.filter((p) => p.card.id !== lastId);
  const choices = others.length > 0 ? others : pool;
  return choices[Math.floor(Math.random() * choices.length)];
}

function newSession(cards: LearnCard[], poolSize: number): Session {
  const deck = shuffle(cards);
  const pool = deck.slice(0, poolSize).map((card) => ({ card, streak: 0 }));
  return {
    pool,
    queue: deck.slice(poolSize),
    current: pickNext(pool),
    learned: 0,
    total: cards.length,
    attempts: 0,
    right: 0,
    missed: new Map(),
  };
}

/** Score the current card, retire it if it's learned, and refill the pool from the queue. */
function applyResult(s: Session, correct: boolean, given: string, timesNeeded: number): Session {
  const cur = s.current;
  if (!cur) return s;
  const streak = correct ? cur.streak + 1 : 0;
  const missed = new Map(s.missed);
  if (!correct) missed.set(cur.card.id, { card: cur.card, given });
  let pool = s.pool.map((p) => (p.card.id === cur.card.id ? { ...p, streak } : p));
  let queue = s.queue;
  let learned = s.learned;
  if (streak >= timesNeeded) {
    pool = pool.filter((p) => p.card.id !== cur.card.id);
    learned++;
    if (queue.length > 0) {
      pool = [...pool, { card: queue[0], streak: 0 }];
      queue = queue.slice(1);
    }
  }
  return { ...s, pool, queue, learned, missed, current: { ...cur, streak }, attempts: s.attempts + 1, right: s.right + (correct ? 1 : 0) };
}

/** Every card in the pack, grouped by answer, for reading through before (or instead of) drilling. */
function CardList({ cards }: { cards: LearnCard[] }) {
  const groups = useMemo(() => {
    const map = new Map<string, LearnCard[]>();
    for (const c of cards) map.set(c.answer, [...(map.get(c.answer) ?? []), c]);
    return [...map.entries()].sort((a, b) => plain(a[0]).localeCompare(plain(b[0])));
  }, [cards]);
  return (
    <div className="mt-2">
      {groups.map(([answer, group]) => (
        <div key={answer} className="mb-3">
          <div className="font-bold"><AnswerText answer={answer} /> <span className="font-normal text-gray-500">({group.length})</span></div>
          <ul className="ml-4">
            {group.map((c) => (
              <li key={c.id}>
                {c.prompt}
                {c.detail && <span className="text-gray-500"> — {c.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function LearnDrill() {
  const { id = "" } = useParams();
  const { data: pack, isLoading, error } = useLearnPack(id);
  const [poolSize, setPoolSize] = useState(DEFAULT_POOL_SIZE);
  const [timesNeeded, setTimesNeeded] = useState(DEFAULT_TIMES_NEEDED);
  const [session, setSession] = useState<Session | null>(null);
  const [input, setInput] = useState("");
  /** Set once the current card is judged; Enter then moves on */
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  /** The answer just judged, so "i was right" can rescore it */
  const [lastGiven, setLastGiven] = useState("");
  const [prompted, setPrompted] = useState(false);
  const [judging, setJudging] = useState(false);
  const [showCards, setShowCards] = useState(false);
  /** The session before the last result, so "i was right" can redo it as correct */
  const [beforeResult, setBeforeResult] = useState<Session | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const start = (cards: LearnCard[]) => {
    setSession(newSession(cards, poolSize));
    setInput("");
    setVerdict(null);
    setPrompted(false);
    setBeforeResult(null);
  };

  // Deal once the pack loads
  const cardCount = pack?.cards?.length ?? 0;
  useEffect(() => {
    if (pack?.cards?.length) start(pack.cards);
  }, [cardCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    inputRef.current?.focus();
  }, [session?.current, verdict, prompted]);

  if (isLoading) return <p>loading...</p>;
  if (error || !pack) return <p className="text-red-600">pack not found. <Link to="/learn" className="underline">back</Link></p>;
  if (!pack.cards?.length) return <p>this pack has no cards yet.</p>;
  if (!session) return null;

  const current = session.current;
  const done = session.pool.length === 0;

  const record = (correct: boolean, given: string) => {
    setBeforeResult(session);
    setSession(applyResult(session, correct, given, timesNeeded));
    setLastGiven(given);
    setVerdict(correct ? "correct" : "incorrect");
  };

  const next = () => {
    setSession((s) => (s ? { ...s, current: pickNext(s.pool, s.current?.card.id) } : s));
    setInput("");
    setVerdict(null);
    setPrompted(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || judging) return;
    if (verdict) return next();
    const given = input.trim();
    if (!given) return record(false, ""); // Enter on an empty box reveals the answer
    setJudging(true);
    try {
      const { verdict: v } = await judgeCard(current.card.id, given);
      // One "more specific?" retry per card, then a prompt counts as a miss
      if (v === "prompt" && !prompted) {
        setPrompted(true);
        setInput("");
      } else {
        record(v === "correct", given);
      }
    } catch {
      record(false, given);
    } finally {
      setJudging(false);
    }
  };

  /** The judge was too strict: redo the last answer as right. */
  const overrule = () => {
    if (!beforeResult) return;
    // The snapshot predates this miss, so only the card's earlier misses stay on record
    setSession(applyResult(beforeResult, true, lastGiven, timesNeeded));
    setBeforeResult(null);
    setVerdict("correct");
  };

  const missed = [...session.missed.values()];
  const numberInput = "border border-black px-1 w-14 font-mono";

  return (
    <div>
      <div className="flex justify-between items-baseline mb-2 gap-4">
        <div>
          <Link to="/learn" className="text-gray-500 hover:text-black">← learn</Link>
          <h1 className="font-bold mt-1">{pack.name}</h1>
        </div>
        <div className="text-right whitespace-nowrap">
          {session.learned}/{session.total} learned · {session.right}/{session.attempts} right
        </div>
      </div>
      <div className="flex flex-wrap gap-4 items-center mb-2 text-gray-600">
        <label className="flex items-center gap-1">
          cycle
          <input type="number" min={1} value={poolSize} onChange={(e) => setPoolSize(Math.max(1, parseInt(e.target.value, 10) || 1))} className={numberInput} />
          at once
        </label>
        <label className="flex items-center gap-1">
          remove after
          <input type="number" min={1} max={5} value={timesNeeded} onChange={(e) => setTimesNeeded(Math.min(5, Math.max(1, parseInt(e.target.value, 10) || 1)))} className={numberInput} />
          right in a row
        </label>
        <button type="button" onClick={() => start(pack.cards!)} className="underline hover:text-black">restart</button>
      </div>
      <div className="h-1 bg-gray-200 mb-6">
        <div className="h-1 bg-black transition-all" style={{ width: `${(session.learned / Math.max(1, session.total)) * 100}%` }} />
      </div>

      {done && !verdict ? (
        <div className="mb-6">
          <p className="mb-3 font-bold">
            all {session.total} learned in {session.attempts} answers ({Math.round((session.right / Math.max(1, session.attempts)) * 100)}% right)
          </p>
          <div className="flex gap-2 mb-4">
            {missed.length > 0 && (
              <button type="button" onClick={() => start(missed.map((m) => m.card))} className="border border-black px-3 py-1">
                drill the {missed.length} you missed
              </button>
            )}
            <button type="button" onClick={() => start(pack.cards!)} className="border border-black px-3 py-1">
              start over
            </button>
          </div>
          {missed.length > 0 && (
            <ul>
              {missed.map((m) => (
                <li key={m.card.id} className="mb-1">
                  {m.card.prompt} → <AnswerText answer={m.card.answer} />
                  {m.given && <span className="text-gray-500"> (you said "{m.given}")</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : current ? (
        <form onSubmit={submit} className="mb-6">
          <p className="text-gray-500 mb-1">
            {pack.promptKind} → {pack.answerKind}?
            <span className="ml-3">
              {"●".repeat(Math.min(current.streak, timesNeeded))}
              {"○".repeat(Math.max(0, timesNeeded - current.streak))}
            </span>
            <span className="ml-3">{session.pool.length} in rotation, {session.queue.length} to come</span>
          </p>
          <p className="text-xl mb-4">{current.card.prompt}</p>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            readOnly={!!verdict || judging}
            className="border border-black px-2 py-1 w-full font-mono mb-2"
            placeholder={prompted ? "more specific?" : `the ${pack.answerKind} (enter to reveal)`}
            autoComplete="off"
          />
          {prompted && !verdict && <p className="text-gray-600">more specific?</p>}
          {verdict && (
            <div className="mt-2">
              <p className={verdict === "correct" ? "text-green-700" : "text-red-600"}>
                {verdict === "correct" ? "correct" : "incorrect"}: <AnswerText answer={current.card.answer} />
                {current.card.detail && <span className="text-gray-500"> — {current.card.detail}</span>}
              </p>
              <div className="flex gap-3 mt-2 text-gray-500">
                <button type="submit" className="border border-black px-3 py-1 text-black">next (enter)</button>
                {verdict === "incorrect" && lastGiven && (
                  <button type="button" onClick={overrule} className="hover:text-black underline">i was right</button>
                )}
              </div>
            </div>
          )}
        </form>
      ) : null}

      <button type="button" onClick={() => setShowCards((s) => !s)} className="text-gray-500 hover:text-black">
        {showCards ? "hide" : "view"} all {pack.cards.length} cards
      </button>
      {showCards && <CardList cards={pack.cards} />}
    </div>
  );
}
