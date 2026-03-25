import { Hono } from "hono";
import { createLogger } from "@3roads/shared";
import type { TossupData, BonusData } from "../game/types.js";

const log = createLogger("api:qbreader");
const QB_BASE = "https://www.qbreader.org/api";

const app = new Hono();

app.get("/sets", async (c) => {
	try {
		const res = await fetch(`${QB_BASE}/set-list`);
		if (!res.ok) return c.json({ error: "QB Reader unavailable" }, 502);
		const data = await res.json() as string[] | { sets?: string[]; setList?: string[] };
		const sets: string[] = Array.isArray(data) ? data : (data.setList ?? data.sets ?? []);
		// Sort alphabetically
		sets.sort((a, b) => a.localeCompare(b));
		return c.json({ sets });
	} catch (err) {
		log.error("Failed to fetch QB Reader set list", err);
		return c.json({ error: "Failed to fetch set list" }, 502);
	}
});

app.get("/num-packets", async (c) => {
	const setName = c.req.query("setName") ?? "";
	if (!setName) return c.json({ error: "setName required" }, 400);
	try {
		const res = await fetch(`${QB_BASE}/num-packets?setName=${encodeURIComponent(setName)}`);
		if (!res.ok) return c.json({ error: "QB Reader unavailable" }, 502);
		const data = await res.json() as { numPackets: number } | number;
		const numPackets = typeof data === "number" ? data : (data.numPackets ?? 0);
		return c.json({ numPackets });
	} catch (err) {
		log.error(`Failed to fetch num-packets for "${setName}"`, err);
		return c.json({ error: "Failed to fetch packet count" }, 502);
	}
});

app.get("/packet", async (c) => {
	const setName = c.req.query("setName") ?? "";
	const packetNumber = c.req.query("packetNumber") ?? "1";
	if (!setName) return c.json({ error: "setName required" }, 400);
	try {
		const url = `${QB_BASE}/packet?setName=${encodeURIComponent(setName)}&packetNumber=${encodeURIComponent(packetNumber)}`;
		log.info(`Fetching QB Reader packet: ${url}`);
		const res = await fetch(url);
		if (!res.ok) return c.json({ error: "QB Reader unavailable" }, 502);
		const data = await res.json() as Record<string, unknown>;
		return c.json(transformPacket(data, setName, packetNumber));
	} catch (err) {
		log.error(`Failed to fetch packet "${setName}" #${packetNumber}`, err);
		return c.json({ error: "Failed to fetch packet" }, 502);
	}
});

interface QbTossup {
	_id?: string;
	question?: string;
	answer?: string;
	formatted_answer?: string;
	category?: string;
	subcategory?: string;
}

interface QbBonusPart {
	text?: string;
	answer?: string;
	formatted_answer?: string;
	number?: number;
	value?: number;
}

interface QbBonus {
	_id?: string;
	leadin?: string;
	// New format: parts is array of objects
	parts?: (string | QbBonusPart)[];
	// Old format: separate arrays
	answers?: string[];
	values?: number[];
	formatted_answers?: string[];
	category?: string;
	subcategory?: string;
}

interface QbPacket {
	tossups?: QbTossup[];
	bonuses?: QbBonus[];
}

function transformPacket(data: Record<string, unknown>, setName: string, packetNumber: string): {
	name: string;
	tossups: TossupData[];
	bonuses: BonusData[];
} {
	const packet = data as QbPacket;
	const name = `${setName} — Packet ${packetNumber}`;

	const tossups: TossupData[] = (packet.tossups ?? []).map((t, i) => ({
		id: `qb-t-${t._id ?? i}`,
		// Keep (*) in text — the game engine already detects it for power scoring
		question: cleanAnswer(t.question ?? ""),
		answer: cleanAnswer(t.formatted_answer ?? t.answer ?? ""),
		powerMarkIndex: null,
		category: t.category ?? "",
		subcategory: t.subcategory ?? "",
		difficulty: "",
	}));

	const bonuses: BonusData[] = (packet.bonuses ?? []).map((b, i) => {
		const parts = normalizeBonusParts(b);
		return {
			id: `qb-b-${b._id ?? i}`,
			leadin: cleanAnswer(b.leadin ?? ""),
			category: b.category ?? "",
			subcategory: b.subcategory ?? "",
			difficulty: "",
			parts,
		};
	});

	return { name, tossups, bonuses };
}

const HTML_ENTITIES: Record<string, string> = {
	"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'",
	"&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&ldquo;": "\u201c", "&rdquo;": "\u201d",
	"&lsquo;": "\u2018", "&rsquo;": "\u2019", "&hellip;": "…", "&shy;": "",
};

function decodeEntities(s: string): string {
	// Named entities
	let out = s.replace(/&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m);
	// Numeric decimal entities like &#160;
	out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
	// Numeric hex entities like &#x00A0;
	out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
	return out;
}

function cleanAnswer(s: string): string {
	return decodeEntities(
		s.replace(/<[^>]*>/g, "") // strip HTML tags only — keep brackets for moderator prompting notes
	)
		.replace(/  +/g, " ")    // collapse double spaces left by removed tags
		.trim();
}

function normalizeBonusParts(b: QbBonus): BonusData["parts"] {
	// QB Reader has two formats depending on API version:
	// New: parts is array of { text, answer, value } objects
	// Old: parts is array of strings, answers/values are separate arrays
	if (!b.parts || b.parts.length === 0) return [];

	if (typeof b.parts[0] === "object" && b.parts[0] !== null) {
		// New object format
		return (b.parts as QbBonusPart[]).map((p, j) => ({
			partNum: j + 1,
			text: cleanAnswer(p.text ?? ""),
			answer: cleanAnswer(p.formatted_answer ?? p.answer ?? ""),
			value: p.value ?? 10,
		}));
	}

	// Old string array format
	return (b.parts as string[]).map((text, j) => ({
		partNum: j + 1,
		text: cleanAnswer(text),
		answer: cleanAnswer(b.formatted_answers?.[j] ?? b.answers?.[j] ?? ""),
		value: b.values?.[j] ?? 10,
	}));
}

export { app as qbreaderRoutes };
