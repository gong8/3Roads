#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB_DIST = path.join(ROOT, "packages/web/dist");
const API_DIR = path.join(ROOT, "packages/api");

const MCP_DIR = path.join(ROOT, "packages/mcp");
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

// Start MCP server
console.log("\n  Starting MCP server...\n");
const mcp = spawn("npx", ["tsx", "src/index.ts"], {
	cwd: MCP_DIR,
	env: { ...process.env },
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
	["tunnel", "--config", path.join(process.env.HOME, ".cloudflared/config-3roads.yml"), "run", TUNNEL_NAME],
	{ stdio: "inherit" },
);

const cleanup = (source) => {
	console.log(`\n  [cleanup] triggered by: ${source}`);
	tunnel.kill();
	api.kill();
	mcp.kill();
	process.exit();
};

mcp.on("exit", (code) => console.log(`  [exit] MCP exited with code ${code}`));
process.on("SIGINT", () => cleanup("SIGINT"));
process.on("SIGTERM", () => cleanup("SIGTERM"));
api.on("exit", (code) => cleanup(`API exit (code ${code})`));
tunnel.on("exit", (code) => cleanup(`tunnel exit (code ${code})`));
