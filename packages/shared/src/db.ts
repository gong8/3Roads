import { PrismaClient } from "@prisma/client";
import { createLogger } from "./logger.js";

const log = createLogger("db");

let prisma: PrismaClient | null = null;
let initialized = false;

export function getDb(): PrismaClient {
	if (!prisma) {
		log.debug("Initializing PrismaClient");
		prisma = new PrismaClient();
	}
	return prisma;
}

export async function initDb(): Promise<void> {
	if (initialized) return;
	const db = getDb();
	await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
	await db.$queryRawUnsafe("PRAGMA busy_timeout=5000");
	initialized = true;
	log.info("Database initialized with WAL mode and busy_timeout=5000ms");
}

export { PrismaClient };
