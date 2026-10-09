import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load secrets (e.g. OPENROUTER_API_KEY) from the repo-root .env files. Must be
// imported before anything that reads process.env at module load time.
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const file of [".env.local", ".env"]) {
	const path = join(root, file);
	if (existsSync(path)) process.loadEnvFile(path);
}
