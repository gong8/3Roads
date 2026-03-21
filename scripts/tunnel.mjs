#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB_DIST = path.join(ROOT, "packages/web/dist");
const API_DIR = path.join(ROOT, "packages/api");

const TUNNEL_NAME = "3roads";
const HOSTNAME = "3roads.nelsongong.com";

// Check cloudflared is installed
try {
	execFileSync("which", ["cloudflared"], { stdio: "ignore" });
} catch {
	console.error("cloudflared not found. Install with: brew install cloudflared");
	process.exit(1);
}

// Build web (turbo handles building shared first)
console.log("\n  Building web...\n");
execFileSync("pnpm", ["turbo", "build", "--filter=@3roads/web"], {
	cwd: ROOT,
	stdio: "inherit",
});

// Start API server with static file serving
console.log("\n  Starting server...\n");
const api = spawn("npx", ["tsx", "src/index.ts"], {
	cwd: API_DIR,
	env: { ...process.env, SERVE_STATIC: WEB_DIST },
	stdio: "inherit",
});

// Wait for API to be ready, then start tunnel
await new Promise((r) => setTimeout(r, 2000));

console.log(`\n  Starting tunnel → https://${HOSTNAME}\n`);
const tunnel = spawn(
	"cloudflared",
	["tunnel", "run", "--url", "http://localhost:7001", TUNNEL_NAME],
	{ stdio: "inherit" },
);

const cleanup = () => {
	tunnel.kill();
	api.kill();
	process.exit();
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
api.on("exit", cleanup);
tunnel.on("exit", cleanup);
