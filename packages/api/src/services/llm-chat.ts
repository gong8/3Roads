import { createLogger } from "@3roads/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RESOURCE } from "./chatgpt-auth.js";
import { LineBuffer } from "./line-buffer.js";

// Inference runs on the signed-in user's ChatGPT plan through the Responses API.
// Requests follow the plan-usage rules: store:false, stream:true, instructions
// instead of system messages, tools in a namespace, no sampling/limit fields.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

const log = createLogger("api:llm");

const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:7002/mcp";
const RESPONSES_URL = `${RESOURCE}/responses`;
export const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const MAX_TURNS = 10;

// Tools are exposed to the model with the same names the prompts (and web UI) already use
const TOOL_PREFIX = "mcp__3roads__";
const TOOL_NAMESPACE = "threeroads";
const ALLOWED_MCP_TOOLS = new Set(["save_tossups_batch", "save_bonuses_batch"]);

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT CONSTRAINTS:",
	"- Use ONLY the provided tools prefixed with mcp__3roads__ to save questions.",
	"- Generate ALL tossups first, then call mcp__3roads__save_tossups_batch ONCE with the full array. Then generate ALL bonuses, then call mcp__3roads__save_bonuses_batch ONCE. Do NOT call individual save_tossup or save_bonus tools.",
	"- Always include category, subcategory, and difficulty for each question.",
	"- NEVER reuse an answer across questions in the same set. Every tossup and every bonus part must have a distinct answer.",
	"- NEVER write clues that transparently give away the answer through etymology, word games, or trivial restatement.",
	"- Every tossup must be strictly pyramidal: hardest clues first, power mark at 1/3-1/2 through, giveaway last.",
	"- In tossups, every sentence must refer to the answer with a 'this <type>' phrase (e.g. 'this food', 'this author'), and the first sentence must not reveal the answer's namesake, word origin, or most famous fact.",
].join("\n");

/** Model slugs come from listModels; old OpenRouter slugs ("vendor/model") use the default. */
function resolveModel(model?: string): string {
	return model && !model.includes("/") ? model : DEFAULT_MODEL;
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

// -- MCP --

async function connectMcp(): Promise<{ client: Client; tools: NamespaceTool[] }> {
	const client = new Client({ name: "3roads-api", version: "0.0.1" });
	await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
	const { tools } = await client.listTools();
	const fns = tools
		.filter((t) => ALLOWED_MCP_TOOLS.has(t.name))
		.map((t) => ({
			type: "function" as const,
			name: TOOL_PREFIX + t.name,
			description: t.description,
			parameters: t.inputSchema,
		}));
	log.debug(`connectMcp — ${fns.length} tools from ${MCP_URL}`);
	return {
		client,
		tools: [{ type: "namespace", name: TOOL_NAMESPACE, description: "Save quiz bowl questions.", tools: fns }],
	};
}

async function callMcpTool(client: Client, call: FunctionCall): Promise<{ text: string; isError: boolean }> {
	const name = call.name.replace(TOOL_PREFIX, "");
	if (!ALLOWED_MCP_TOOLS.has(name)) {
		return { text: `Error: tool ${call.name} is not available`, isError: true };
	}
	let args: Record<string, unknown>;
	try {
		args = call.arguments ? JSON.parse(call.arguments) : {};
	} catch (err) {
		return { text: `Error: invalid JSON arguments: ${err instanceof Error ? err.message : err}`, isError: true };
	}
	try {
		const result = await client.callTool({ name, arguments: args });
		const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
		return { text: content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
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

// -- Agent loop --

async function runAgentLoop(options: {
	token: string;
	prompt: string;
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
	emit?: SSEEmitter;
	useTools: boolean;
}): Promise<string> {
	const model = resolveModel(options.model);
	const startMs = performance.now();
	log.info(`runAgentLoop START — model=${model} tools=${options.useTools} prompt=${options.prompt.length} chars`);

	const mcp = options.useTools ? await connectMcp() : undefined;
	// store:false means no server-side history: every turn resends the whole conversation.
	const input: InputItem[] = [{ role: "user", content: options.prompt }];
	let lastContent = "";

	try {
		for (let turn = 1; turn <= MAX_TURNS; turn++) {
			const { content, calls } = await streamResponse({
				token: options.token,
				model,
				instructions: options.systemPrompt,
				input,
				tools: mcp?.tools ?? [],
				emit: options.emit,
				signal: options.signal,
			});
			lastContent = content;

			if (calls.length === 0 || !mcp) break;

			for (const call of calls) {
				let args: unknown = {};
				try {
					args = call.arguments ? JSON.parse(call.arguments) : {};
				} catch {}
				log.info(`runAgentLoop — tool_call_complete: ${call.name} (${call.call_id})`);
				options.emit?.("tool_call_args", JSON.stringify({ toolCallId: call.call_id, toolName: call.name, args }));

				const { text, isError } = await callMcpTool(mcp.client, call);
				if (isError) log.warn(`runAgentLoop — tool ${call.name} error: ${text.slice(0, 300)}`);
				options.emit?.("tool_result", JSON.stringify({ toolCallId: call.call_id, result: text, isError }));
				input.push({ type: "function_call", ...call });
				input.push({ type: "function_call_output", call_id: call.call_id, output: text });
			}
		}
	} finally {
		await mcp?.client.close().catch(() => {});
	}

	log.info(`runAgentLoop DONE — ${(performance.now() - startMs).toFixed(0)}ms`);
	return lastContent;
}

// -- Public API --

export interface LlmChatOptions {
	/** The signed-in user's ChatGPT access token. */
	token: string;
	prompt: string;
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
}

/** Tool-using generation run (saves questions via MCP). */
export async function runLlmChat(options: LlmChatOptions): Promise<{ ok: boolean; result?: string; error?: string }> {
	try {
		const result = await runAgentLoop({
			...options,
			systemPrompt: options.systemPrompt + SYSTEM_PROMPT_SUFFIX,
			useTools: true,
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
	return runAgentLoop({ ...options, useTools: false });
}

/** Tool-using generation run streamed as SSE events. */
export function streamLlmChat(options: LlmChatOptions): ReadableStream<Uint8Array> {
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
					useTools: true,
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
