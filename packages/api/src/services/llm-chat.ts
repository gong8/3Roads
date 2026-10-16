import { createLogger } from "@3roads/shared";
import { getAccessToken, RESOURCE } from "./chatgpt-auth.js";
import { LineBuffer } from "./line-buffer.js";
import { type BonusInput, saveBonuses, saveTossups, type TossupInput } from "./question-store.js";

// Inference runs on the signed-in user's ChatGPT plan through the Responses API.
// Requests follow the plan-usage rules: store:false, stream:true, instructions
// instead of system messages, tools in a namespace, no sampling/limit fields.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

const log = createLogger("api:llm");

const RESPONSES_URL = `${RESOURCE}/responses`;
export const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const MAX_TURNS = 10;

// Tools are exposed to the model with the same names the prompts (and web UI) already use
const TOOL_PREFIX = "mcp__3roads__";
const TOOL_NAMESPACE = "threeroads";

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT CONSTRAINTS:",
	"- Use ONLY the provided tools prefixed with mcp__3roads__ to save questions.",
	"- Generate ALL tossups first, then call mcp__3roads__save_tossups_batch ONCE with the full array. Then generate ALL bonuses, then call mcp__3roads__save_bonuses_batch ONCE. Do NOT call individual save_tossup or save_bonus tools.",
	"- Always include category, subcategory, and difficulty for each question.",
	"- NEVER reuse an answer across questions in the same set. Every tossup and every bonus part must have a distinct answer.",
	"- NEVER write clues that transparently give away the answer through etymology, word games, or trivial restatement.",
	"- Every tossup must be strictly pyramidal: hardest clues first, (*) placed immediately before the first word that gives the answer away (1/3-1/2 through), giveaway last.",
	"- In tossups, every sentence must refer to the answer with a 'this <type>' phrase (e.g. 'this food', 'this author'), and the first sentence must not reveal the answer's namesake, word origin, or most famous fact.",
].join("\n");

// OpenRouter is the second provider: the server's OPENROUTER_API_KEY pays, so anyone can
// use these models without connecting ChatGPT. Its slugs are "vendor/model"; ChatGPT plan
// slugs never contain a slash, which is how a request is routed.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS = [
	{ slug: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor (cheapest)" },
	{ slug: "meta/muse-spark-1.3", name: "Muse Spark 1.3" },
	{ slug: "meta/muse-spark-1.2", name: "Muse Spark 1.2" },
	{ slug: "meta/muse-glimmer-30b", name: "Muse Glimmer 30B (fast)" },
];
export const DEFAULT_OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || OPENROUTER_MODELS[0].slug;

export function openRouterEnabled(): boolean {
	return !!process.env.OPENROUTER_API_KEY;
}

/**
 * The OpenRouter account's balance in USD: credits bought, used, and left. The account
 * balance is the real limit (a key's own cap can be higher), so this reads /credits.
 */
export async function openRouterCredits(): Promise<{ total: number; used: number; remaining: number }> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new LlmError("OPENROUTER_API_KEY is not set", "openrouter_disabled");
	const res = await fetch("https://openrouter.ai/api/v1/credits", {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new LlmError(`OpenRouter credits returned ${res.status}`);
	const { data } = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
	const total = data?.total_credits ?? 0;
	const used = data?.total_usage ?? 0;
	return { total, used, remaining: total - used };
}

export function isOpenRouterModel(model?: string): boolean {
	return !!model?.includes("/");
}

/** Why a model can't run: ChatGPT models need the user's plan, OpenRouter models the server key. */
export function modelUnavailableMessage(model?: string): string {
	return isOpenRouterModel(model)
		? "OpenRouter models aren't available on this server (no OPENROUTER_API_KEY)"
		: "Connect ChatGPT in settings to generate with this model, or pick an OpenRouter model";
}

/** Whether this user can run this model: OpenRouter needs the server key, ChatGPT models a connected plan. */
export async function canUseModel(userId: string, model?: string): Promise<boolean> {
	if (isOpenRouterModel(model)) return openRouterEnabled();
	return !!(await getAccessToken(userId).catch(() => null));
}

/** The model to use when the caller has no preference: the user's ChatGPT plan, else OpenRouter, else null. */
export async function defaultModelFor(userId: string | undefined, chatgptModel = DEFAULT_MODEL): Promise<string | null> {
	if (userId && (await getAccessToken(userId).catch(() => null))) return chatgptModel;
	return openRouterEnabled() ? DEFAULT_OPENROUTER_MODEL : null;
}

/** ChatGPT plan model to request: an explicit plan slug, or the default. */
function resolveModel(model?: string): string {
	return model && !isOpenRouterModel(model) ? model : DEFAULT_MODEL;
}

type SSEEmitter = (event: string, data: string) => void;

type InputItem =
	| { role: "user"; content: string }
	| { type: "function_call"; call_id: string; name: string; arguments: string }
	| { type: "function_call_output"; call_id: string; output: string };

interface FunctionCall {
	call_id: string;
	name: string;
	arguments: string;
}

interface NamespaceTool {
	type: "namespace";
	name: string;
	description: string;
	tools: { type: "function"; name: string; description?: string; parameters: unknown }[];
}

/** Error from the ChatGPT plan route, with OpenAI's error code when it gave one. */
export class LlmError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

// -- Save tools (in-process, bound to the run's set) --

const tossupSchema = {
	type: "object",
	properties: {
		question: { type: "string", description: "The tossup question text" },
		answer: { type: "string", description: "The answer to the tossup, with the part a player must say wrapped in {braces}, e.g. \"{Bakerloo} line\"" },
		powerMarkIndex: { type: "number", description: "Character index of the power mark (*)" },
		category: { type: "string", description: "Question category (e.g., Science, History)" },
		subcategory: { type: "string", description: "Question subcategory" },
		difficulty: { type: "string", description: "Difficulty level" },
	},
	required: ["question", "answer", "category", "subcategory", "difficulty"],
};

const bonusSchema = {
	type: "object",
	properties: {
		leadin: { type: "string", description: "The bonus leadin text" },
		part1Text: { type: "string" },
		part1Answer: { type: "string", description: "Answer, with the part a player must say wrapped in {braces}, e.g. \"{Bakerloo} line\"" },
		part2Text: { type: "string" },
		part2Answer: { type: "string", description: "Answer, with the part a player must say wrapped in {braces}, e.g. \"{Bakerloo} line\"" },
		part3Text: { type: "string" },
		part3Answer: { type: "string", description: "Answer, with the part a player must say wrapped in {braces}, e.g. \"{Bakerloo} line\"" },
		category: { type: "string", description: "Question category (e.g., Science, History)" },
		subcategory: { type: "string" },
		difficulty: { type: "string" },
	},
	required: [
		"leadin", "part1Text", "part1Answer", "part2Text", "part2Answer", "part3Text", "part3Answer",
		"category", "subcategory", "difficulty",
	],
};

// setId is accepted because the prompts mention it, but ignored: a run can only ever
// write into the set it was started for.
const SAVE_TOOLS: NamespaceTool[] = [
	{
		type: "namespace",
		name: TOOL_NAMESPACE,
		description: "Save quiz bowl questions.",
		tools: [
			{
				type: "function",
				name: `${TOOL_PREFIX}save_tossups_batch`,
				description: "Save multiple quiz bowl tossups to the set in one call.",
				parameters: {
					type: "object",
					properties: { setId: { type: "string" }, tossups: { type: "array", items: tossupSchema } },
					required: ["tossups"],
				},
			},
			{
				type: "function",
				name: `${TOOL_PREFIX}save_bonuses_batch`,
				description: "Save multiple quiz bowl bonuses to the set in one call.",
				parameters: {
					type: "object",
					properties: { setId: { type: "string" }, bonuses: { type: "array", items: bonusSchema } },
					required: ["bonuses"],
				},
			},
		],
	},
];

async function callSaveTool(setId: string, call: FunctionCall): Promise<{ text: string; isError: boolean }> {
	let args: { tossups?: TossupInput[]; bonuses?: BonusInput[] };
	try {
		args = call.arguments ? JSON.parse(call.arguments) : {};
	} catch (err) {
		return { text: `Error: invalid JSON arguments: ${err instanceof Error ? err.message : err}`, isError: true };
	}
	try {
		if (call.name === `${TOOL_PREFIX}save_tossups_batch`) {
			await saveTossups(setId, args.tossups ?? []);
			return { text: `Saved ${args.tossups?.length} tossups.`, isError: false };
		}
		if (call.name === `${TOOL_PREFIX}save_bonuses_batch`) {
			await saveBonuses(setId, args.bonuses ?? []);
			return { text: `Saved ${args.bonuses?.length} bonuses.`, isError: false };
		}
		return { text: `Error: tool ${call.name} is not available`, isError: true };
	} catch (err) {
		return { text: `Error: ${err instanceof Error ? err.message : err}`, isError: true };
	}
}

// -- Responses streaming --

export async function streamResponse(options: {
	token: string;
	model: string;
	instructions: string;
	input: InputItem[];
	tools: NamespaceTool[];
	emit?: SSEEmitter;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}): Promise<{ content: string; calls: FunctionCall[] }> {
	const http = options.fetch ?? fetch;
	const body = {
		model: options.model,
		instructions: options.instructions,
		input: options.input,
		store: false,
		stream: true,
		...(options.tools.length > 0 ? { tools: options.tools } : {}),
	};

	// Only temporary routing outages are retried. Quota (429) never is.
	let res: Response;
	for (let attempt = 0; ; attempt++) {
		res = await http(RESPONSES_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token}` },
			body: JSON.stringify(body),
			signal: options.signal,
		});
		if (res.status !== 503 || attempt >= 2) break;
		await res.body?.cancel();
		await new Promise((r) => setTimeout(r, 1000 * 3 ** attempt));
	}

	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		let code: string | undefined;
		try {
			code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
		} catch {}
		throw new LlmError(`OpenAI ${res.status}${code ? ` (${code})` : ""}: ${text.slice(0, 300)}`, code);
	}

	let content = "";
	let completed = false;
	const calls: FunctionCall[] = [];
	const lineBuffer = new LineBuffer();
	const decoder = new TextDecoder();

	for await (const chunk of res.body) {
		for (const line of lineBuffer.push(decoder.decode(chunk, { stream: true }))) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) continue;
			let msg: Record<string, any>;
			try {
				msg = JSON.parse(trimmed.slice(5).trim());
			} catch {
				continue;
			}

			switch (msg.type) {
				case "response.output_text.delta":
					content += msg.delta;
					options.emit?.("content", JSON.stringify({ content: msg.delta }));
					break;
				case "response.output_item.added":
					if (msg.item?.type === "function_call") {
						log.info(`streamResponse — tool_call_start: ${msg.item.name} (${msg.item.call_id})`);
						options.emit?.(
							"tool_call_start",
							JSON.stringify({ toolCallId: msg.item.call_id, toolName: msg.item.name }),
						);
					}
					break;
				case "response.output_item.done":
					if (msg.item?.type === "function_call") {
						calls.push({ call_id: msg.item.call_id, name: msg.item.name, arguments: msg.item.arguments ?? "" });
					}
					break;
				case "response.completed":
					completed = true;
					break;
				case "response.failed":
				case "response.incomplete":
				case "error": {
					const err = msg.response?.error ?? msg.error ?? msg;
					throw new LlmError(`OpenAI ${msg.type}: ${err.message ?? JSON.stringify(err).slice(0, 300)}`, err.code);
				}
			}
		}
	}

	// response.completed is the only success signal; a stream can just stop.
	if (!completed) throw new LlmError("OpenAI stream ended before response.completed");
	return { content, calls };
}

// -- OpenRouter chat completions --

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

// Chat completions has no tool namespaces: the same save tools, flattened
const OPENROUTER_TOOLS = SAVE_TOOLS.flatMap((ns) =>
	ns.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
);

async function streamOpenRouter(options: {
	model: string;
	messages: ChatMessage[];
	useTools: boolean;
	emit?: SSEEmitter;
	signal?: AbortSignal;
}): Promise<{ content: string; calls: FunctionCall[]; cost: number }> {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new LlmError("OPENROUTER_API_KEY is not set", "openrouter_disabled");

	const res = await fetch(OPENROUTER_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-Title": "3Roads" },
		body: JSON.stringify({
			model: options.model,
			messages: options.messages,
			stream: true,
			usage: { include: true },
			...(options.useTools ? { tools: OPENROUTER_TOOLS } : {}),
		}),
		signal: options.signal,
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		throw new LlmError(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
	}

	let content = "";
	let cost = 0;
	// Tool calls arrive as fragments keyed by index
	const calls = new Map<number, FunctionCall>();
	const lineBuffer = new LineBuffer();
	const decoder = new TextDecoder();

	for await (const chunk of res.body) {
		for (const line of lineBuffer.push(decoder.decode(chunk, { stream: true }))) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) continue;
			const payload = trimmed.slice(5).trim();
			if (payload === "[DONE]") continue;
			let msg: Record<string, any>;
			try {
				msg = JSON.parse(payload);
			} catch {
				continue;
			}
			if (msg.error) throw new LlmError(`OpenRouter: ${msg.error.message ?? JSON.stringify(msg.error)}`);
			if (typeof msg.usage?.cost === "number") cost += msg.usage.cost;

			const delta = msg.choices?.[0]?.delta;
			if (!delta) continue;
			if (delta.content) {
				content += delta.content;
				options.emit?.("content", JSON.stringify({ content: delta.content }));
			}
			for (const d of delta.tool_calls ?? []) {
				const index = d.index ?? 0;
				let call = calls.get(index);
				if (!call) {
					call = { call_id: d.id || `tool_${index}`, name: d.function?.name ?? "", arguments: "" };
					calls.set(index, call);
					log.info(`streamOpenRouter — tool_call_start: ${call.name} (${call.call_id})`);
					options.emit?.("tool_call_start", JSON.stringify({ toolCallId: call.call_id, toolName: call.name }));
				}
				if (d.function?.arguments) call.arguments += d.function.arguments;
			}
		}
	}
	return { content, calls: [...calls.values()], cost };
}

async function runOpenRouterLoop(options: {
	model: string;
	prompt: string;
	systemPrompt: string;
	signal?: AbortSignal;
	emit?: SSEEmitter;
	setId?: string;
	onCost?: (usd: number) => void;
}): Promise<string> {
	const messages: ChatMessage[] = [
		{ role: "system", content: options.systemPrompt },
		{ role: "user", content: options.prompt },
	];
	let lastContent = "";
	let totalCost = 0;

	for (let turn = 1; turn <= MAX_TURNS; turn++) {
		const { content, calls, cost } = await streamOpenRouter({
			model: options.model,
			messages,
			useTools: !!options.setId,
			emit: options.emit,
			signal: options.signal,
		});
		totalCost += cost;
		// Reported per turn, so a run that fails later is still counted
		options.onCost?.(cost);
		lastContent = content;

		if (calls.length === 0 || !options.setId) break;

		messages.push({
			role: "assistant",
			content: content || null,
			tool_calls: calls.map((c) => ({ id: c.call_id, type: "function", function: { name: c.name, arguments: c.arguments } })),
		});
		for (const call of calls) {
			let args: unknown = {};
			try {
				args = call.arguments ? JSON.parse(call.arguments) : {};
			} catch {}
			log.info(`runOpenRouterLoop — tool_call_complete: ${call.name} (${call.call_id})`);
			options.emit?.("tool_call_args", JSON.stringify({ toolCallId: call.call_id, toolName: call.name, args }));

			const { text, isError } = await callSaveTool(options.setId, call);
			if (isError) log.warn(`runOpenRouterLoop — tool ${call.name} error: ${text.slice(0, 300)}`);
			options.emit?.("tool_result", JSON.stringify({ toolCallId: call.call_id, result: text, isError }));
			messages.push({ role: "tool", tool_call_id: call.call_id, content: text });
		}
	}

	log.info(`runOpenRouterLoop — cost=$${totalCost.toFixed(4)}`);
	return lastContent;
}

// -- Agent loop --

async function runAgentLoop(options: {
	userId?: string;
	prompt: string;
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
	emit?: SSEEmitter;
	/** When set, the model gets the save tools, bound to this set. */
	setId?: string;
	onCost?: (usd: number) => void;
}): Promise<string> {
	const startMs = performance.now();
	if (isOpenRouterModel(options.model)) {
		log.info(`runAgentLoop START — openrouter model=${options.model} set=${options.setId ?? "-"} prompt=${options.prompt.length} chars`);
		const result = await runOpenRouterLoop({ ...options, model: options.model! });
		log.info(`runAgentLoop DONE — ${(performance.now() - startMs).toFixed(0)}ms`);
		return result;
	}

	const model = resolveModel(options.model);
	log.info(`runAgentLoop START — model=${model} set=${options.setId ?? "-"} prompt=${options.prompt.length} chars`);

	// store:false means no server-side history: every turn resends the whole conversation.
	const input: InputItem[] = [{ role: "user", content: options.prompt }];
	let lastContent = "";

	for (let turn = 1; turn <= MAX_TURNS; turn++) {
		// Fetched per turn: the server refreshes the user's grant when it nears expiry.
		const token = options.userId ? await getAccessToken(options.userId) : null;
		if (!token) throw new LlmError("ChatGPT is not connected. Connect it in settings.", "not_connected");
		const { content, calls } = await streamResponse({
			token,
			model,
			instructions: options.systemPrompt,
			input,
			tools: options.setId ? SAVE_TOOLS : [],
			emit: options.emit,
			signal: options.signal,
		});
		lastContent = content;

		if (calls.length === 0 || !options.setId) break;

		for (const call of calls) {
			let args: unknown = {};
			try {
				args = call.arguments ? JSON.parse(call.arguments) : {};
			} catch {}
			log.info(`runAgentLoop — tool_call_complete: ${call.name} (${call.call_id})`);
			options.emit?.("tool_call_args", JSON.stringify({ toolCallId: call.call_id, toolName: call.name, args }));

			const { text, isError } = await callSaveTool(options.setId, call);
			if (isError) log.warn(`runAgentLoop — tool ${call.name} error: ${text.slice(0, 300)}`);
			options.emit?.("tool_result", JSON.stringify({ toolCallId: call.call_id, result: text, isError }));
			input.push({ type: "function_call", ...call });
			input.push({ type: "function_call_output", call_id: call.call_id, output: text });
		}
	}

	log.info(`runAgentLoop DONE — ${(performance.now() - startMs).toFixed(0)}ms`);
	return lastContent;
}

// -- Public API --

export interface LlmChatOptions {
	/** The 3Roads user whose ChatGPT plan pays for this run. Not needed for OpenRouter models. */
	userId?: string;
	prompt: string;
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
	/**
	 * Called with each completion's USD cost. Only OpenRouter reports one: ChatGPT plan usage
	 * is part of the user's subscription, so those runs never call it.
	 */
	onCost?: (usd: number) => void;
}

/** Tool-using generation run that saves questions into `setId`. */
export async function runLlmChat(
	options: LlmChatOptions & { setId: string },
): Promise<{ ok: boolean; result?: string; error?: string }> {
	try {
		const result = await runAgentLoop({
			...options,
			systemPrompt: options.systemPrompt + SYSTEM_PROMPT_SUFFIX,
		});
		return { ok: true, result };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`runLlmChat failed: ${msg}`);
		return { ok: false, error: msg };
	}
}

/** Single-turn text completion, no tools. */
export function runLlmChatSimple(options: LlmChatOptions): Promise<string> {
	return runAgentLoop({ ...options, setId: undefined });
}

/** Tool-using generation run streamed as SSE events. */
export function streamLlmChat(options: LlmChatOptions & { setId: string }): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			const emit: SSEEmitter = (event, data) => {
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
			};

			try {
				await runAgentLoop({
					...options,
					systemPrompt: options.systemPrompt + SYSTEM_PROMPT_SUFFIX,
					emit,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				log.error(`streamLlmChat failed: ${msg}`);
				emit("error", JSON.stringify({ error: msg }));
			}
			emit("done", "[DONE]");
			controller.close();
		},
	});
}

/** Models the signed-in account can use. */
export async function listModels(token: string): Promise<{ slug: string; name: string }[]> {
	const res = await fetch(`${RESOURCE}/models`, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new LlmError(`Model list returned ${res.status}`);
	const json = (await res.json()) as {
		models?: { slug: string; display_name?: string; visibility?: string }[];
		data?: { id: string }[];
	};
	if (json.models) {
		return json.models
			.filter((m) => m.visibility === "list")
			.map((m) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
	}
	return (json.data ?? []).map((m) => ({ slug: m.id, name: m.id }));
}
