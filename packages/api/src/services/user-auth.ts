import { verifyToken } from "@clerk/backend";
import { createLogger, getDb } from "@3roads/shared";
import type { Context, Next } from "hono";

// 3Roads is invite-only: Clerk (Google sign-in, waitlist mode) decides who has an
// account, and every API route and game socket requires a valid Clerk session.
// Verification is networkless with the instance's public JWT key, so the server
// needs no Clerk secret key.

const log = createLogger("api:user-auth");

const JWT_KEY = process.env.CLERK_JWT_KEY?.replace(/\\n/g, "\n");
// Optional tightening: when set, only sessions minted for these origins are accepted
// (Clerk's `azp` check), and these origins may also open game sockets. Unset works out
// of the box: any session from this Clerk instance, and same-host game sockets.
export const AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

// Local testing: LOCAL_AUTH=1 signs every request and socket in as one local user, so the
// app runs without a Clerk instance. Never in a deployment: refuse to start if it is
// combined with production settings.
const LOCAL_AUTH = process.env.LOCAL_AUTH === "1";
if (LOCAL_AUTH && (process.env.SERVE_STATIC || process.env.NODE_ENV === "production")) {
	throw new Error("LOCAL_AUTH=1 is for local development only; unset it (SERVE_STATIC or NODE_ENV=production is set)");
}
const LOCAL_USER: SessionUser = { id: "local-dev", email: "local@localhost" };

if (LOCAL_AUTH) log.warn("LOCAL_AUTH=1: sign-in is disabled, everyone is the local dev user");
else if (!JWT_KEY) log.error("CLERK_JWT_KEY is not set: every request will be treated as signed out");

/**
 * True when the page that opened the socket is ours: same host name as the server
 * (ports may differ, as in dev where the page is on :7003 and the API on :7001),
 * or listed in CLERK_AUTHORIZED_PARTIES.
 */
export function ownOrigin(origin: string | undefined, host: string | undefined): boolean {
	if (!origin) return false;
	if (AUTHORIZED_PARTIES.includes(origin)) return true;
	try {
		return new URL(origin).hostname === new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
}

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
	if (LOCAL_AUTH) return rememberUser(LOCAL_USER);
	const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
	const token = bearer || sessionCookie(cookie);
	if (!token || !JWT_KEY) return null;
	let payload: { sub?: string; email?: unknown };
	try {
		payload = await verifyToken(token, {
			jwtKey: JWT_KEY,
			...(AUTHORIZED_PARTIES.length > 0 ? { authorizedParties: AUTHORIZED_PARTIES } : {}),
		});
	} catch {
		return null;
	}
	if (!payload.sub) return null;
	// The email claim comes from the session token template (see README).
	return rememberUser({ id: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined });
}

/** Make sure the user has a row (sets, ChatGPT connection and results hang off it). */
async function rememberUser(user: SessionUser): Promise<SessionUser> {
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
