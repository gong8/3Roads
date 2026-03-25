import { Hono } from "hono";
import { createLogger } from "@3roads/shared";
import { runCliChatSimple } from "../services/cli-chat.js";
import type { TossupData } from "../game/types.js";

const log = createLogger("api:picture-rounds");
const app = new Hono();

const WIKI_API = "https://en.wikipedia.org/api/rest_v1/page/summary";

interface WikiSummary {
	title: string;
	displaytitle?: string;
	thumbnail?: { source: string; width: number; height: number };
	originalimage?: { source: string; width: number; height: number };
	extract?: string;
	description?: string;
}

async function fetchWikiThumbnail(title: string): Promise<{ imageUrl: string; answer: string; description: string } | null> {
	try {
		const url = `${WIKI_API}/${encodeURIComponent(title)}`;
		const res = await fetch(url, { headers: { "User-Agent": "3Roads-QuizBowl/1.0" } });
		if (!res.ok) return null;
		const data = await res.json() as WikiSummary;
		const imageUrl = data.thumbnail?.source ?? data.originalimage?.source;
		if (!imageUrl) return null;
		return {
			imageUrl,
			answer: data.title,
			description: data.description ?? data.extract?.slice(0, 100) ?? "",
		};
	} catch (err) {
		log.warn(`Wikipedia fetch failed for "${title}": ${err instanceof Error ? err.message : err}`);
		return null;
	}
}

/**
 * GET /picture-rounds/generate?count=10&theme=flags&difficulty=Regular+High+School
 *
 * Returns an ExternalPacket-style object with tossups that have imageUrl set.
 * Uses a single Haiku call to generate Wikipedia topic names, then fetches images.
 */
app.get("/generate", async (c) => {
	const count = Math.min(Math.max(parseInt(c.req.query("count") ?? "10"), 1), 30);
	const theme = c.req.query("theme") ?? "famous people, landmarks, and artworks";
	const difficulty = c.req.query("difficulty") ?? "Regular High School";

	log.info(`Generating ${count} picture round questions — theme="${theme}" difficulty="${difficulty}"`);

	// Single small Haiku call to get Wikipedia topic names
	const prompt = `Generate exactly ${count} Wikipedia article titles suitable for a picture round quiz at "${difficulty}" level on the theme: "${theme}".

Rules:
- Each title must be a real Wikipedia article that has an image (famous people, landmarks, artworks, flags, animals, etc.)
- Titles must be distinct and span a range of difficulties
- Use exact Wikipedia article titles (e.g. "Eiffel Tower" not "the Eiffel Tower")
- For people, use "Firstname Lastname" format

Output ONLY a JSON array of strings, no markdown, no extra text. Example: ["Albert Einstein", "Eiffel Tower"]`;

	let topics: string[];
	try {
		const raw = await runCliChatSimple({
			prompt,
			systemPrompt: "You are a quiz bowl expert. Output only valid JSON arrays.",
			model: "haiku",
		});
		// Strip markdown fences if present
		const cleaned = raw.replace(/```[a-z]*\n?/g, "").trim();
		topics = JSON.parse(cleaned) as string[];
		if (!Array.isArray(topics)) throw new Error("Not an array");
		topics = topics.slice(0, count);
	} catch (err) {
		log.error("Failed to generate topics from Claude", err);
		return c.json({ error: "Failed to generate topic list" }, 500);
	}

	log.info(`Got ${topics.length} topics from Claude, fetching Wikipedia thumbnails...`);

	// Fetch Wikipedia thumbnails in parallel
	const results = await Promise.all(topics.map((title) => fetchWikiThumbnail(title)));

	const tossups: TossupData[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (!r) {
			log.warn(`No image found for "${topics[i]}", skipping`);
			continue;
		}
		tossups.push({
			id: `pic-${i}-${Date.now()}`,
			question: r.description ? `Identify this: ${r.description}` : "",
			answer: r.answer,
			powerMarkIndex: null,
			imageUrl: r.imageUrl,
			category: "Picture Round",
			subcategory: theme,
			difficulty,
		});
	}

	if (tossups.length === 0) {
		return c.json({ error: "No images found for any of the generated topics" }, 502);
	}

	log.info(`Picture round ready: ${tossups.length} questions`);
	return c.json({
		name: `Picture Round: ${theme}`,
		tossups,
		bonuses: [],
	});
});

export { app as pictureRoundsRoutes };
