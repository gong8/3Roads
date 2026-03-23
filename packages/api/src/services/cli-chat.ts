import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@3roads/shared";
import { LineBuffer } from "./line-buffer.js";

const log = createLogger("api:cli");

const BASE_TEMP_DIR = join(tmpdir(), "3roads-cli");
const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:7002/mcp";
const LLM_MODEL = process.env.LLM_MODEL || "haiku";

const SYSTEM_PROMPT_SUFFIX = [
	"",
	"IMPORTANT CONSTRAINTS:",
	"- Use ONLY MCP tools prefixed with mcp__3roads__ to save questions. Never attempt to use filesystem, code editing, web browsing, or any non-MCP tools.",
	"- Generate ALL tossups first, then call mcp__3roads__save_tossups_batch ONCE with the full array. Then generate ALL bonuses, then call mcp__3roads__save_bonuses_batch ONCE. Do NOT call individual save_tossup or save_bonus tools.",
	"- Always include category, subcategory, and difficulty for each question.",
	"- NEVER reuse an answer across questions in the same set. Every tossup and every bonus part must have a distinct answer.",
	"- NEVER write clues that transparently give away the answer through etymology, word games, or trivial restatement.",
	"- Every tossup must be strictly pyramidal: hardest clues first, power mark at 1/3-1/2 through, giveaway last.",
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
	"mcp__3roads__search_questions",
	"mcp__3roads__save_tossup",
	"mcp__3roads__save_bonus",
	"mcp__3roads__create_set",
	"mcp__3roads__get_sets",
	"mcp__3roads__get_set",
];

function getCliModel(model: string): string {
	if (model.includes("opus")) return "opus";
	if (model.includes("haiku")) return "haiku";
	return "sonnet";
}

function createInvocationDir(): string {
	const dir = join(BASE_TEMP_DIR, randomUUID().slice(0, 12));
	mkdirSync(dir, { recursive: true });
	log.debug(`prepareInvocation — temp dir: ${dir}`);
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
	const path = writeTempFile(dir, "mcp-config.json", JSON.stringify({ mcpServers: servers }));
	log.debug(`prepareInvocation — MCP config: ${path}`);
	return path;
}

function writeSystemPrompt(dir: string, content: string): string {
	const path = writeTempFile(dir, "system-prompt.txt", content + SYSTEM_PROMPT_SUFFIX);
	log.debug(`prepareInvocation — system prompt: ${path}`);
	return path;
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
	outputFormat: "stream-json" | "json" = "stream-json",
): string[] {
	const args = [
		"--print",
		"--output-format",
		outputFormat,
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
		"10",
	];
	if (outputFormat === "stream-json") {
		args.push("--verbose", "--include-partial-messages");
	}
	args.push(prompt);
	return args;
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
			log.info(`createStreamParser — tool_call_start: ${toolName} (${toolCallId})`);
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
		} catch (err) {
			log.warn(`Failed to parse tool call args for ${tc.name}: ${err instanceof Error ? err.message : err} — raw: ${tc.argsJson.slice(0, 200)}`);
		}
		log.info(`createStreamParser — tool_call_complete: ${tc.name} (${tc.id})`);
		log.debug(`createStreamParser — tool_call_args: ${JSON.stringify(args).slice(0, 500)}`);
		emitSSE("tool_call_args", JSON.stringify({ toolCallId: tc.id, toolName: tc.name, args }));
	}

	function processEvent(event: Record<string, unknown>): void {
		log.debug(`createStreamParser — event type: ${event.type as string}`);
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
	log.info(`spawnCli — claude ${args.join(" ")}`);
	return spawn("claude", args, {
		cwd,
		env: {
			...process.env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function pipeStdout(
	proc: ChildProcessWithoutNullStreams,
	parser: ReturnType<typeof createStreamParser>,
	startMs: number,
	emit: SSEEmitter,
): void {
	const lineBuffer = new LineBuffer();

	proc.stdout?.on("data", (chunk: Buffer) => {
		for (const line of lineBuffer.push(chunk.toString())) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			log.debug(`pipeStdout — raw NDJSON: ${trimmed.slice(0, 500)}`);

			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(trimmed);
			} catch (err) {
				log.warn(`pipeStdout — JSON parse error: ${err instanceof Error ? err.message : err} — line: ${trimmed.slice(0, 200)}`);
				continue;
			}

			parser.process(msg);

			if (msg.type === "result") {
				const elapsed = (performance.now() - startMs).toFixed(0);
				const cost = msg.cost_usd ? `$${(msg.cost_usd as number).toFixed(4)}` : "n/a";
				log.info(`cli-chat DONE — ${elapsed}ms, ${msg.num_turns ?? "?"} turns, cost=${cost}`);
				if (msg.is_error) {
					const errMsg = (msg.result as string) || "CLI returned an error";
					log.error(`cli-chat result error: ${errMsg}`);
					emit("error", JSON.stringify({ error: errMsg }));
				}
			}
		}
	});
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		log.warn(`cleanupDir — failed to remove ${dir}: ${err instanceof Error ? err.message : err}`);
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

	pipeStdout(proc, parser, startMs, emitSSE);

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
		log.error(`cli-chat process error: ${err.message}`, err);
		finalize(err.message);
		cleanupDir(invocationDir);
	});
}

export async function runCliChat(
	options: CliChatOptions,
): Promise<{ ok: boolean; result?: string; error?: string; cost?: number }> {
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
		"json",
	);

	log.info(`runCliChat START — model=${model} prompt=${options.prompt.length} chars`);
	const startMs = performance.now();

	return new Promise((resolve) => {
		let proc: ChildProcessWithoutNullStreams;
		try {
			proc = spawnCli(args, invocationDir);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown spawn error";
			log.error(`runCliChat spawn failed: ${msg}`);
			cleanupDir(invocationDir);
			resolve({ ok: false, error: msg });
			return;
		}

		proc.stdin?.end();

		if (options.signal) {
			options.signal.addEventListener("abort", () => {
				log.info(`runCliChat abort signal, killing PID ${proc.pid}`);
				proc.kill("SIGTERM");
			});
		}

		let stdout = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) log.warn(`runCliChat stderr: ${text.slice(0, 300)}`);
		});

		proc.on("close", (code) => {
			const elapsed = (performance.now() - startMs).toFixed(0);
			log.info(`runCliChat process exited code=${code} elapsed=${elapsed}ms`);
			cleanupDir(invocationDir);

			try {
				const parsed = JSON.parse(stdout);
				const cost = typeof parsed.cost_usd === "number" ? parsed.cost_usd : undefined;
				if (parsed.is_error) {
					resolve({ ok: false, error: parsed.result || "CLI error", cost });
				} else {
					resolve({ ok: true, result: parsed.result, cost });
				}
			} catch {
				if (code !== 0) {
					resolve({ ok: false, error: `CLI exited with code ${code}` });
				} else {
					resolve({ ok: true, result: stdout });
				}
			}
		});

		proc.on("error", (err) => {
			log.error(`runCliChat process error: ${err.message}`);
			cleanupDir(invocationDir);
			resolve({ ok: false, error: err.message });
		});
	});
}

export async function runCliChatSimple(options: {
	prompt: string;
	systemPrompt: string;
	model?: string;
}): Promise<string> {
	const invocationDir = createInvocationDir();
	const model = getCliModel(options.model ?? LLM_MODEL);
	const systemPromptPath = writeTempFile(
		invocationDir,
		"system-prompt.txt",
		options.systemPrompt,
	);

	const args = [
		"--print",
		"--output-format",
		"json",
		"--model",
		model,
		"--dangerously-skip-permissions",
		"--append-system-prompt-file",
		systemPromptPath,
		"--setting-sources",
		"",
		"--no-session-persistence",
		"--max-turns",
		"1",
		options.prompt,
	];

	log.info(`runCliChatSimple START — model=${model} prompt=${options.prompt.length} chars`);
	const startMs = performance.now();

	return new Promise((resolve, reject) => {
		let proc: ChildProcessWithoutNullStreams;
		try {
			proc = spawnCli(args, invocationDir);
		} catch (err) {
			cleanupDir(invocationDir);
			reject(err);
			return;
		}

		proc.stdin?.end();

		let stdout = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) log.warn(`runCliChatSimple stderr: ${text.slice(0, 300)}`);
		});

		proc.on("close", (code) => {
			const elapsed = (performance.now() - startMs).toFixed(0);
			log.info(`runCliChatSimple exited code=${code} elapsed=${elapsed}ms`);
			cleanupDir(invocationDir);

			try {
				const parsed = JSON.parse(stdout);
				if (parsed.is_error) {
					reject(new Error(parsed.result || "CLI error"));
				} else {
					resolve(parsed.result || stdout);
				}
			} catch {
				if (code !== 0) {
					reject(new Error(`CLI exited with code ${code}`));
				} else {
					resolve(stdout);
				}
			}
		});

		proc.on("error", (err) => {
			cleanupDir(invocationDir);
			reject(err);
		});
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

			log.debug(`prepareInvocation — CLI args: claude ${args.join(" ")}`);

			const startMs = performance.now();
			log.info(
				`cli-chat START — model=${model} mcp=${MCP_URL} prompt=${options.prompt.length} chars`,
			);
			log.debug(`streamCliChat — ReadableStream started`);

			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = spawnCli(args, invocationDir);
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Unknown spawn error";
				log.error(`cli-chat spawn failed: ${msg}`, err);
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
