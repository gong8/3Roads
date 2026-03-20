import { execSync } from "node:child_process";

const ports = [7001, 7002, 7003];

for (const port of ports) {
	try {
		if (process.platform === "win32") {
			// Find PIDs listening on the port and kill them
			const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
				encoding: "utf-8",
			});
			const pids = [
				...new Set(
					result
						.trim()
						.split("\n")
						.map((line) => line.trim().split(/\s+/).pop())
						.filter(Boolean),
				),
			];
			for (const pid of pids) {
				try {
					execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
				} catch {}
			}
		} else {
			execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" });
		}
	} catch {
		// No process on this port — that's fine
	}
}

console.log(`Killed ports ${ports.join(", ")}`);
