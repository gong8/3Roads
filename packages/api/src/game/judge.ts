import { spawn } from "node:child_process";
import { createLogger } from "@3roads/shared";

const log = createLogger("api:game:judge");

export async function judgeAnswer(
	submittedAnswer: string,
	canonicalAnswer: string,
	questionText: string,
	strictness: number,
): Promise<{ correct: boolean }> {
	if (!submittedAnswer.trim()) {
		return { correct: false };
	}

	const prompt = [
		"You are a quiz bowl answer judge.",
		`The canonical answer is: ${canonicalAnswer}`,
		`The player submitted: ${submittedAnswer}`,
		`The question was: ${questionText.slice(0, 500)}`,
		`Strictness: ${strictness} (0.0 = accept any reasonable variation, 1.0 = require exact match).`,
		'Respond with ONLY "correct" or "incorrect".',
	].join("\n");

	try {
		const result = await spawnJudge(prompt);
		const correct = result.trim().toLowerCase().includes("correct") &&
			!result.trim().toLowerCase().startsWith("incorrect");
		log.info(`judge — submitted="${submittedAnswer}" canonical="${canonicalAnswer}" verdict=${correct ? "correct" : "incorrect"}`);
		return { correct };
	} catch (err) {
		log.error(`judge — error: ${err instanceof Error ? err.message : err}, treating as incorrect`);
		return { correct: false };
	}
}

function spawnJudge(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const args = [
			"--print",
			"--model",
			"haiku",
			"--max-turns",
			"1",
			"--no-session-persistence",
			"--setting-sources",
			"",
			prompt,
		];

		const proc = spawn("claude", args, {
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const timeout = setTimeout(() => {
			proc.kill("SIGTERM");
			reject(new Error("Judge timed out after 3s"));
		}, 3000);

		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (code !== 0 && !stdout.trim()) {
				reject(new Error(`Judge exited with code ${code}: ${stderr.slice(0, 200)}`));
			} else {
				resolve(stdout);
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		proc.stdin.end();
	});
}
