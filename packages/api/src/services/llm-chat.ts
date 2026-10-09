import { createLogger } from "@3roads/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LineBuffer } from "./line-buffer.js";

const log = createLogger("api:llm");

const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:7002/mcp";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta/muse-spark-1.3-contributor";
const MAX_TURNS = 10;

// Tools are exposed to the model with the same names the prompts (and web UI) already use
const TOOL_PREFIX = "mcp__3roads__";
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
].join("\n");

function getApiKey(): string {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set");
	return key;
}

/**
 * Callers still pass legacy names like "haiku"/"opus"; anything that isn't an
 * OpenRouter slug ("vendor/model") resolves to the configured default.
 */
function resolveModel(model?: string): string {
	return model?.includes("/") ? model : OPENROUTER_MODEL;
}

type SSEEmitter = (event: string, data: string) => void;

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface OpenAiTool {
	type: "function";
	function: { name: string; description?: string; parameters: unknown };
}

// -- MCP --

async function connectMcp(): Promise<{ client: Client; tools: OpenAiTool[] }> {
	const client = new Client({ name: "3roads-api", version: "0.0.1" });
	await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
	const { tools } = await client.listTools();
	const openAiTools = tools
		.filter((t) => ALLOWED_MCP_TOOLS.has(t.name))
		.map((t) => ({
			type: "function" as const,
			function: {
				name: TOOL_PREFIX + t.name,
				description: t.description,
				parameters: t.inputSchema,
			},
		}));
	log.debug(`connectMcp — ${openAiTools.length} tools from ${MCP_URL}`);
	return { client, tools: openAiTools };
}

async function callMcpTool(
	client: Client,
	tc: ToolCall,
): Promise<{ text: string; isError: boolean }> {
	const name = tc.function.name.replace(TOOL_PREFIX, "");
	if (!ALLOWED_MCP_TOOLS.has(name)) {
		return { text: `Error: tool ${tc.function.name} is not available`, isError: true };
	}
	let args: Record<string, unknown>;
	try {
		args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
	} catch (err) {
		return {
			text: `Error: invalid JSON arguments: ${err instanceof Error ? err.message : err}`,
			isError: true,
		};
	}
	try {
		const result = await client.callTool({ name, arguments: args });
		const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
		return {
			text: content.map((c) => c.text ?? "").join(""),
			isError: result.isError === true,
		};
	} catch (err) {
		return { text: `Error: ${err instanceof Error ? err.message : err}`, isError: true };
	}
}

// -- OpenRouter streaming completion --

interface CompletionResult {
	content: string;
	toolCalls: ToolCall[];
	cost: number;
}

async function streamCompletion(
	model: string,
	messages: ChatMessage[],
	tools: OpenAiTool[],
	emit: SSEEmitter | undefined,
	signal?: AbortSignal,
): Promise<CompletionResult> {
	const res = await fetch(OPENROUTER_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${getApiKey()}`,
			"X-Title": "3Roads",
		},
		body: JSON.stringify({
			model,
			messages,
			stream: true,
			usage: { include: true },
			...(tools.length > 0 ? { tools } : {}),
		}),
		signal,
	});

	if (!res.ok || !res.body) {
		const body = await res.text().catch(() => "");
		throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
	}

	let content = "";
	let cost = 0;
	let thinking = false;
	const toolCalls = new Map<number, ToolCall>();
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
			if (msg.error) throw new Error(`OpenRouter: ${msg.error.message ?? JSON.stringify(msg.error)}`);
			if (typeof msg.usage?.cost === "number") cost += msg.usage.cost;

			const delta = msg.choices?.[0]?.delta;
			if (!delta) continue;

			if (delta.reasoning) {
				if (!thinking) {
					thinking = true;
					emit?.("thinking_start", JSON.stringify({}));
				}
				emit?.("thinking_delta", JSON.stringify({ text: delta.reasoning }));
			}
			if (delta.content) {
				content += delta.content;
				emit?.("content", JSON.stringify({ content: delta.content }));
			}
			for (const d of delta.tool_calls ?? []) {
				const index = d.index ?? 0;
				let tc = toolCalls.get(index);
				if (!tc) {
					tc = {
						id: d.id || `tool_${index}`,
						type: "function",
						function: { name: d.function?.name ?? "", arguments: "" },
					};
					toolCalls.set(index, tc);
					log.info(`streamCompletion — tool_call_start: ${tc.function.name} (${tc.id})`);
					emit?.(
						"tool_call_start",
						JSON.stringify({ toolCallId: tc.id, toolName: tc.function.name }),
					);
				}
				if (d.function?.arguments) tc.function.arguments += d.function.arguments;
			}
		}
	}

	return { content, toolCalls: [...toolCalls.values()], cost };
}

// -- Agent loop --

async function runAgentLoop(options: {
	prompt: string;
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
	emit?: SSEEmitter;
	useTools: boolean;
}): Promise<{ result: string; cost: number }> {
	const model = resolveModel(options.model);
	const startMs = performance.now();
	log.info(`runAgentLoop START — model=${model} tools=${options.useTools} prompt=${options.prompt.length} chars`);

	const mcp = options.useTools ? await connectMcp() : undefined;
	const messages: ChatMessage[] = [
		{ role: "system", content: options.systemPrompt },
		{ role: "user", content: options.prompt },
	];
	let totalCost = 0;
	let lastContent = "";

	try {
		for (let turn = 1; turn <= MAX_TURNS; turn++) {
			const { content, toolCalls, cost } = await streamCompletion(
				model,
				messages,
				mcp?.tools ?? [],
				options.emit,
				options.signal,
			);
			totalCost += cost;
			lastContent = content;

			if (toolCalls.length === 0 || !mcp) break;

			messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });

			for (const tc of toolCalls) {
				let args: unknown = {};
				try {
					args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
				} catch {}
				log.info(`runAgentLoop — tool_call_complete: ${tc.function.name} (${tc.id})`);
				options.emit?.(
					"tool_call_args",
					JSON.stringify({ toolCallId: tc.id, toolName: tc.function.name, args }),
				);

				const { text, isError } = await callMcpTool(mcp.client, tc);
				if (isError) log.warn(`runAgentLoop — tool ${tc.function.name} error: ${text.slice(0, 300)}`);
				options.emit?.(
					"tool_result",
					JSON.stringify({ toolCallId: tc.id, result: text, isError }),
				);
				messages.push({ role: "tool", tool_call_id: tc.id, content: text });
			}
		}
	} finally {
		await mcp?.client.close().catch(() => {});
	}

	const elapsed = (performance.now() - startMs).toFixed(0);
	log.info(`runAgentLoop DONE — ${elapsed}ms, cost=$${totalCost.toFixed(4)}`);
	return { result: lastContent, cost: totalCost };
}

// -- Public API --

export interface LlmChatOptions {
	prompt: string;
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
}

/** Tool-using generation run (saves questions via MCP). */
export async function runLlmChat(
	options: LlmChatOptions,
): Promise<{ ok: boolean; result?: string; error?: string; cost?: number }> {
	try {
		const { result, cost } = await runAgentLoop({
			...options,
			systemPrompt: options.systemPrompt + SYSTEM_PROMPT_SUFFIX,
			useTools: true,
		});
		return { ok: true, result, cost };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`runLlmChat failed: ${msg}`);
		return { ok: false, error: msg };
	}
}

/** Single-turn text completion, no tools. */
export async function runLlmChatSimple(options: {
	prompt: string;
	systemPrompt: string;
	model?: string;
}): Promise<string> {
	const { result } = await runAgentLoop({ ...options, useTools: false });
	return result;
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
