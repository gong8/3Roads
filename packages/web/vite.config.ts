import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const configuredBase = process.env.VITE_BASE_PATH || env.VITE_BASE_PATH || "/";
	const base = `/${configuredBase.split("/").filter(Boolean).join("/")}${configuredBase === "/" ? "" : "/"}`;

	return {
		base,
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
					rewrite: (path) => path.replace(/^\/api/, ""),
				},
			},
		},
	};
});
