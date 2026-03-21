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
		`Leniency: ${strictness}/10. At 1, require an exact match. At 10, accept any answer that demonstrates knowledge of the correct answer. At the default of 7, accept reasonable variations like missing articles, minor misspellings, or partial but clearly correct answers.`,
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
			reject(new Error("Judge timed out after 30s"));
		}, 30000);

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
