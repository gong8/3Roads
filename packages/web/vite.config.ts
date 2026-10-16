import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const configuredBase = process.env.VITE_BASE_PATH || env.VITE_BASE_PATH || "/";
	const base = `/${configuredBase.split("/").filter(Boolean).join("/")}${configuredBase === "/" ? "" : "/"}`;
	// LOCAL_AUTH lives in the repo-root .env.local, shared with the API. Only the dev server
	// honours it: `vite build` always bakes in false, so a deployed site can't skip sign-in.
	const rootEnv = loadEnv(mode, path.resolve(__dirname, "../.."), "");
	const localAuth = command === "serve" && (process.env.LOCAL_AUTH ?? rootEnv.LOCAL_AUTH) === "1";

	return {
		base,
		define: {
			"import.meta.env.VITE_LOCAL_AUTH": JSON.stringify(localAuth),
		},
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src"),
			},
		},
		server: {
			host: true,
			port: 7003,
			proxy: {
				"/api": {
					target: "http://localhost:7001",
					changeOrigin: true,
				},
			},
		},
	};
});
