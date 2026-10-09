import { verifyToken } from "@clerk/backend";
import { createLogger, getDb } from "@3roads/shared";
import type { Context, Next } from "hono";

// 3Roads is invite-only: Clerk (Google sign-in, waitlist mode) decides who has an
// account, and every API route and game socket requires a valid Clerk session.
// Verification is networkless with the instance's public JWT key, so the server
// needs no Clerk secret key.

const log = createLogger("api:user-auth");

const JWT_KEY = process.env.CLERK_JWT_KEY?.replace(/\\n/g, "\n");
// Origins allowed to present session tokens (Clerk's `azp` check).
const AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES ?? "http://localhost:7003")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
if (!JWT_KEY) log.error("CLERK_JWT_KEY is not set: every request will be treated as signed out");

export interface SessionUser {
	id: string;
	email?: string;
}

const knownUsers = new Set<string>();

function sessionCookie(cookieHeader: string | undefined): string | undefined {
	for (const part of cookieHeader?.split(";") ?? []) {
		const i = part.indexOf("=");
		if (part.slice(0, i).trim() === "__session") return decodeURIComponent(part.slice(i + 1).trim());
	}
	return undefined;
}

/** The signed-in user for these request headers, or null. Fails closed. */
export async function userFromHeaders(authorization: string | undefined, cookie: string | undefined): Promise<SessionUser | null> {
	const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
	const token = bearer || sessionCookie(cookie);
	if (!token || !JWT_KEY) return null;
	let payload: { sub?: string; email?: unknown };
	try {
		payload = await verifyToken(token, { jwtKey: JWT_KEY, authorizedParties: AUTHORIZED_PARTIES });
	} catch {
		return null;
	}
	if (!payload.sub) return null;
	// The email claim comes from the session token template (see README).
	const user = { id: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
	if (!knownUsers.has(user.id)) {
		await getDb().user.upsert({
			where: { id: user.id },
			create: { id: user.id, email: user.email ?? null },
			update: { email: user.email ?? null },
		});
		knownUsers.add(user.id);
	}
	return user;
}

const users = new WeakMap<Request, SessionUser>();

/** Hono middleware: 401 unless the request carries a valid Clerk session. */
export async function requireUser(c: Context, next: Next) {
	const user = await userFromHeaders(c.req.header("authorization"), c.req.header("cookie"));
	if (!user) return c.json({ error: "Sign in required" }, 401);
	users.set(c.req.raw, user);
	await next();
}

/** The user `requireUser` admitted for this request. */
export function currentUser(c: Context): SessionUser {
	const user = users.get(c.req.raw);
	if (!user) throw new Error("currentUser called on a route without requireUser");
	return user;
}
