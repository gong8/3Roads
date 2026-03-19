import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@3roads/shared";
import { LineBuffer } from "./line-buffer.js";

const log = createLogger("api");

const BASE_TEMP_DIR = join(tmpdir(), "3roads-cli");
const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:3001/mcp";
const LLM_MODEL = process.env.LLM_MODEL || "sonnet";

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT CONSTRAINTS:",
	"- You are a quiz bowl question writer. Use MCP tools prefixed with mcp__3roads__ to save questions.",
	"- Never attempt to use filesystem, code editing, web browsing, or any non-MCP tools.",
	"- For each tossup, call mcp__3roads__save_tossup immediately after writing it.",
	"- For each bonus, call mcp__3roads__save_bonus immediately after writing it.",
	"- Generate pyramidal tossups: start with obscure clues, progressively get easier, include a power mark (*) at the transition point.",
	"- Generate bonuses with a leadin and exactly 3 parts of increasing difficulty (easy/medium/hard), each worth 10 points.",
	"- Always include category, subcategory, and difficulty for each question.",
].join("\n");

const BLOCKED_BUILTIN_TOOLS = [
	"Bash",
	"Read",
	"Write",
	"Edit",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"Task",
	"TaskOutput",
	"NotebookEdit",
	"EnterPlanMode",
	"ExitPlanMode",
	"TodoWrite",
	"AskUserQuestion",
	"Skill",
	"TeamCreate",
	"TeamDelete",
	"SendMessage",
	"TaskStop",
	"ToolSearch",
];

function getCliModel(model: string): string {
	if (model.includes("opus")) return "opus";
	if (model.includes("haiku")) return "haiku";
	return "sonnet";
}

function createInvocationDir(): string {
	const dir = join(BASE_TEMP_DIR, randomUUID().slice(0, 12));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeTempFile(dir: string, filename: string, content: string): string {
	const filePath = join(dir, filename);
	writeFileSync(filePath, content);
	return filePath;
}

function writeMcpConfig(dir: string): string {
	const servers: Record<string, unknown> = {
		"3roads": { type: "http", url: MCP_URL },
	};
	return writeTempFile(dir, "mcp-config.json", JSON.stringify({ mcpServers: servers }));
}

function writeSystemPrompt(dir: string, content: string): string {
	return writeTempFile(dir, "system-prompt.txt", content + SYSTEM_PROMPT_SUFFIX);
}

export interface CliChatOptions {
	prompt: string;
	systemPrompt: string;
	model?: string;
	signal?: AbortSignal;
}

function buildCliArgs(
	model: string,
	mcpConfigPath: string,
	systemPromptPath: string,
	disallowedTools: string[],
	prompt: string,
): string[] {
	return [
		"--print",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		model,
		"--dangerously-skip-permissions",
		"--mcp-config",
		mcpConfigPath,
		"--strict-mcp-config",
		"--disallowedTools",
		...disallowedTools,
		"--append-system-prompt-file",
		systemPromptPath,
		"--setting-sources",
		"",
		"--no-session-persistence",
		"--max-turns",
		"50",
		prompt,
	];
}

type BlockType = "text" | "tool_use" | "thinking";

type SSEEmitter = (event: string, data: string) => void;

function extractToolResultText(
	blockContent: string | Array<Record<string, unknown>> | undefined,
): string {
	if (typeof blockContent === "string") return blockContent;
	if (Array.isArray(blockContent)) {
		return blockContent.map((c) => (c.text as string) || "").join("");
	}
	return "";
}

function emitToolResultsFromContent(
	content: Array<Record<string, unknown>> | undefined,
	emitSSE: SSEEmitter,
): void {
	if (!content) return;
	for (const block of content) {
		if (block.type !== "tool_result") continue;
		emitSSE(
			"tool_result",
			JSON.stringify({
				toolCallId: block.tool_use_id as string,
				result: extractToolResultText(
					block.content as string | Array<Record<string, unknown>> | undefined,
				),
				isError: block.is_error === true,
			}),
		);
	}
}

function emitUserToolResults(msg: Record<string, unknown>, emitSSE: SSEEmitter): void {
	const message = msg.message as Record<string, unknown> | undefined;
	if (message?.role === "user") {
		emitToolResultsFromContent(
			message.content as Array<Record<string, unknown>> | undefined,
			emitSSE,
		);
	}
}

function createStreamParser(emitSSE: SSEEmitter) {
	const blockTypes = new Map<number, BlockType>();
	const toolCalls = new Map<number, { id: string; name: string; argsJson: string }>();

	function handleBlockStart(index: number, block: Record<string, unknown>): void {
		const blockType = block.type as string;
		if (blockType === "tool_use") {
			blockTypes.set(index, "tool_use");
			const toolCallId = (block.id as string) || `tool_${index}`;
			const toolName = (block.name as string) || "unknown";
			toolCalls.set(index, { id: toolCallId, name: toolName, argsJson: "" });
			emitSSE("tool_call_start", JSON.stringify({ toolCallId, toolName }));
		} else if (blockType === "thinking") {
			blockTypes.set(index, "thinking");
			emitSSE("thinking_start", JSON.stringify({}));
		} else {
			blockTypes.set(index, "text");
		}
	}

	function handleBlockDelta(index: number, delta: Record<string, unknown>): void {
		const deltaType = delta.type as string;
		const blockType = blockTypes.get(index);

		if (deltaType === "text_delta" && delta.text && blockType === "text") {
			emitSSE("content", JSON.stringify({ content: delta.text as string }));
		} else if (deltaType === "input_json_delta" && delta.partial_json !== undefined) {
			const tc = toolCalls.get(index);
			if (tc) tc.argsJson += delta.partial_json as string;
		} else if (deltaType === "thinking_delta" && delta.thinking) {
			emitSSE("thinking_delta", JSON.stringify({ text: delta.thinking as string }));
		}
	}

	function handleBlockStop(index: number): void {
		if (blockTypes.get(index) !== "tool_use") return;
		const tc = toolCalls.get(index);
		if (!tc) return;
		let args: Record<string, unknown> = {};
		try {
			args = tc.argsJson ? JSON.parse(tc.argsJson) : {};
		} catch {
			log.warn(`Failed to parse tool call args for ${tc.name}`);
		}
		emitSSE("tool_call_args", JSON.stringify({ toolCallId: tc.id, toolName: tc.name, args }));
	}

	function processEvent(event: Record<string, unknown>): void {
		const index = event.index as number;
		const block =
			event.type === "content_block_start"
				? (event.content_block as Record<string, unknown>)
				: undefined;
		const delta =
			event.type === "content_block_delta" ? (event.delta as Record<string, unknown>) : undefined;

		if (block) handleBlockStart(index, block);
		else if (delta) handleBlockDelta(index, delta);
		else if (event.type === "content_block_stop") handleBlockStop(index);
		else if (event.type === "message_start") emitUserToolResults(event, emitSSE);
	}

	return {
		process(msg: Record<string, unknown>): void {
			if (msg.type === "user") {
				emitUserToolResults(msg, emitSSE);
				return;
			}
			if (msg.type !== "stream_event") return;
			const event = msg.event as Record<string, unknown> | undefined;
			if (event) processEvent(event);
		},
	};
}

function spawnCli(args: string[], cwd: string): ChildProcessWithoutNullStreams {
	return spawn("claude", args, {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			SHELL: process.env.SHELL,
			TERM: process.env.TERM,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function pipeStdout(
	proc: ChildProcessWithoutNullStreams,
	parser: ReturnType<typeof createStreamParser>,
	startMs: number,
): void {
	const lineBuffer = new LineBuffer();

	proc.stdout?.on("data", (chunk: Buffer) => {
		for (const line of lineBuffer.push(chunk.toString())) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(trimmed);
			} catch {
				continue;
			}

			parser.process(msg);

			if (msg.type === "result") {
				const elapsed = (performance.now() - startMs).toFixed(0);
				const cost = msg.cost_usd ? `$${(msg.cost_usd as number).toFixed(4)}` : "n/a";
				log.info(`cli-chat DONE — ${elapsed}ms, ${msg.num_turns ?? "?"} turns, cost=${cost}`);
			}
		}
	});
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
}

function wireProcessLifecycle(
	proc: ChildProcessWithoutNullStreams,
	emitSSE: SSEEmitter,
	parser: ReturnType<typeof createStreamParser>,
	startMs: number,
	invocationDir: string,
	signal?: AbortSignal,
): void {
	proc.stdin?.end();
	log.info(`cli-chat PID: ${proc.pid}`);

	if (signal) {
		signal.addEventListener("abort", () => {
			log.info(`cli-chat abort signal, killing PID ${proc.pid}`);
			proc.kill("SIGTERM");
		});
	}

	let closed = false;
	const finalize = (emitError?: string): void => {
		if (closed) return;
		closed = true;
		if (emitError) emitSSE("error", JSON.stringify({ error: emitError }));
		emitSSE("done", "[DONE]");
	};

	pipeStdout(proc, parser, startMs);

	proc.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim();
		if (text) log.warn(`cli-chat stderr: ${text.slice(0, 300)}`);
	});

	proc.on("close", (code) => {
		const elapsed = (performance.now() - startMs).toFixed(0);
		log.info(`cli-chat process exited code=${code} elapsed=${elapsed}ms`);
		finalize();
		cleanupDir(invocationDir);
	});

	proc.on("error", (err) => {
		log.error(`cli-chat process error: ${err.message}`);
		finalize(err.message);
		cleanupDir(invocationDir);
	});
}

export function streamCliChat(options: CliChatOptions): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();

	return new ReadableStream({
		async start(controller) {
			let closed = false;
			const emit: SSEEmitter = (event, data) => {
				if (closed) return;
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
			};
			const close = () => {
				if (closed) return;
				closed = true;
				controller.close();
			};

			const invocationDir = createInvocationDir();
			const systemPromptPath = writeSystemPrompt(invocationDir, options.systemPrompt);
			const model = getCliModel(options.model ?? LLM_MODEL);
			const mcpConfigPath = writeMcpConfig(invocationDir);
			const args = buildCliArgs(
				model,
				mcpConfigPath,
				systemPromptPath,
				BLOCKED_BUILTIN_TOOLS,
				options.prompt,
			);

			const startMs = performance.now();
			log.info(
				`cli-chat START — model=${model} mcp=${MCP_URL} prompt=${options.prompt.length} chars`,
			);

			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = spawnCli(args, invocationDir);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Unknown spawn error";
				log.error(`cli-chat spawn failed: ${msg}`);
				emit("error", JSON.stringify({ error: msg }));
				emit("done", "[DONE]");
				close();
				return;
			}

			const parser = createStreamParser(emit);
			proc.on("close", close);
			proc.on("error", close);
			wireProcessLifecycle(proc, emit, parser, startMs, invocationDir, options.signal);
		},
	});
}
