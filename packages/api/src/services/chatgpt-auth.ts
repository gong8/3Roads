import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@3roads/shared";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

// "Sign in with ChatGPT" (open-source flow), one ChatGPT account per browser:
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// The server keeps no user credentials. Tokens live in the user's own HttpOnly
// cookies and pass through this process only for the request that uses them.
// The server signs the cookies it issues and ignores unsigned ones, so made-up
// tokens never cause a request to OpenAI.
// The flow only allows a 127.0.0.1 callback, so the user pastes the URL their
// browser lands on back into 3Roads, which finishes the exchange.

const log = createLogger("api:chatgpt-auth");

const issuer = "https://auth.openai.com";
const authorizeUrl = `${issuer}/api/accounts/authorize`;
const tokenUrl = `${issuer}/api/accounts/oauth/token`;
const revokeUrl = `${issuer}/api/accounts/oauth/revoke`;
export const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const UNUSABLE_REFRESH = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

// Cookie names
const AT = "cg_at";
const RT = "cg_rt";
const META = "cg_meta";
const LOGIN = "cg_login";

export class AuthError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

interface Meta {
	clientId: string;
	email?: string;
	expiresAt: number; // epoch ms
	earliestRefreshAt?: number; // epoch ms
	sig?: string; // HMAC over the access token, refresh token and the fields above
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in: number;
	scope?: string;
	earliest_refresh_at?: number | string;
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

// Per-install state: the stable host ID OpenAI asks for, and a random key that signs
// session cookies. The key is local to this install and grants no access to anything.
const HOST_FILE =
	process.env.CHATGPT_HOST_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "../../../../data/chatgpt-host.json");
let host: { hostId: string; cookieKey: string } | undefined;
function getHost() {
	if (host) return host;
	const saved = existsSync(HOST_FILE)
		? (JSON.parse(readFileSync(HOST_FILE, "utf8")) as { hostId?: string; cookieKey?: string })
		: {};
	host = {
		hostId: saved.hostId ?? `urn:uuid:${randomUUID()}`,
		cookieKey: saved.cookieKey ?? b64url(randomBytes(32)),
	};
	if (saved.hostId !== host.hostId || saved.cookieKey !== host.cookieKey) {
		writeFileSync(HOST_FILE, JSON.stringify(host), { mode: 0o600 });
	}
	return host;
}

// A sign-in in progress (PKCE verifier, state, nonce) lives in the starting browser's own
// HttpOnly cookie, not in server memory: nothing for unauthenticated requests to fill or
// evict, and only the browser that started a sign-in can finish it.
const PENDING_TTL = 10 * 60_000;
interface Pending {
	state: string;
	verifier: string;
	nonce: string;
	clientId: string;
}

function isHttps(c: Context): boolean {
	return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

function cookieOpts(c: Context, maxAge: number) {
	return { path: "/", httpOnly: true, secure: isHttps(c), sameSite: "Strict" as const, maxAge };
}

const REFRESH_MAX_AGE = 30 * 24 * 3600; // refresh tokens last 30 days

function saveTokens(c: Context, tokens: TokenResponse, prev: Meta & { refreshToken?: string }, email?: string) {
	const meta: Meta = {
		clientId: prev.clientId,
		email: email ?? prev.email,
		expiresAt: Date.now() + tokens.expires_in * 1000,
		earliestRefreshAt: parseEarliest(tokens.earliest_refresh_at),
	};
	const refreshToken = tokens.refresh_token ?? prev.refreshToken;
	if (!refreshToken) throw new AuthError("Token response has no refresh token");
	meta.sig = sign(tokens.access_token, refreshToken, meta);
	setCookie(c, AT, tokens.access_token, cookieOpts(c, REFRESH_MAX_AGE));
	setCookie(c, RT, refreshToken, cookieOpts(c, REFRESH_MAX_AGE));
	setCookie(c, META, Buffer.from(JSON.stringify(meta)).toString("base64url"), cookieOpts(c, REFRESH_MAX_AGE));
	return { accessToken: tokens.access_token, meta };
}

function clearTokens(c: Context) {
	for (const name of [AT, RT, META]) deleteCookie(c, name, { path: "/" });
}

function parseEarliest(value: TokenResponse["earliest_refresh_at"]) {
	if (value == null) return undefined;
	const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function sign(accessToken: string, refreshToken: string, meta: Meta): string {
	const { sig: _, ...fields } = meta;
	return createHmac("sha256", getHost().cookieKey)
		.update(JSON.stringify([accessToken, refreshToken, fields]))
		.digest("base64url");
}

interface Session {
	accessToken: string;
	refreshToken: string;
	meta: Meta;
}

/** The session in these cookies, only if this server issued it. */
function readSession(cookie: (name: string) => string | undefined): Session | undefined {
	const accessToken = cookie(AT);
	const refreshToken = cookie(RT);
	const raw = cookie(META);
	if (!accessToken || !refreshToken || !raw) return undefined;
	let meta: Meta;
	try {
		meta = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Meta;
	} catch {
		return undefined;
	}
	const expected = Buffer.from(sign(accessToken, refreshToken, meta));
	const given = Buffer.from(meta.sig ?? "");
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
	return { accessToken, refreshToken, meta };
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch(tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
		signal: AbortSignal.timeout(15_000),
	});
	const text = await res.text();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(text);
	} catch {}
	if (!res.ok) {
		const code = typeof json.error === "string" ? json.error : undefined;
		throw new AuthError(`Token endpoint returned ${res.status}${code ? ` (${code})` : ""}`, code);
	}
	return json as unknown as TokenResponse;
}

/** Starts a sign-in; returns the OpenAI URL the browser should open. */
export function beginLogin(c: Context): string {
	const verifier = b64url(randomBytes(32));
	const state = b64url(randomBytes(24));
	const nonce = b64url(randomBytes(24));
	// Reuse this browser's issued client ID; first sign-in registers through the dynamic entrypoint.
	const clientId = readSession((n) => getCookie(c, n))?.meta.clientId ?? "dynamic_agent_client";

	const params = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPE,
		resource: RESOURCE,
		state,
		nonce,
		code_challenge_method: "S256",
		code_challenge: b64url(createHash("sha256").update(verifier).digest()),
	});
	if (clientId === "dynamic_agent_client") {
		params.set("agent_name_hint", "3Roads");
		params.set("ext_agent_host_id", getHost().hostId);
	}
	const pending: Pending = { state, verifier, nonce, clientId };
	setCookie(c, LOGIN, Buffer.from(JSON.stringify(pending)).toString("base64url"), cookieOpts(c, PENDING_TTL / 1000));
	return `${authorizeUrl}?${params}`;
}

/** Finishes a sign-in from the callback URL the user pasted. */
export async function completeLogin(c: Context, pastedUrl: string): Promise<{ email?: string }> {
	let query: URLSearchParams;
	try {
		query = new URL(pastedUrl.trim()).searchParams;
	} catch {
		throw new AuthError("That doesn't look like a URL. Paste the whole address from the address bar.");
	}
	let attempt: Pending | undefined;
	try {
		attempt = JSON.parse(Buffer.from(getCookie(c, LOGIN) ?? "", "base64url").toString("utf8")) as Pending;
	} catch {}
	if (!attempt?.state || attempt.state !== query.get("state")) {
		throw new AuthError("Unknown or expired sign-in attempt. Start again in this browser.");
	}
	deleteCookie(c, LOGIN, { path: "/" });

	const error = query.get("error");
	if (error) throw new AuthError(`Sign-in was not completed: ${error}`, error);
	const code = query.get("code");
	if (!code) throw new AuthError("The URL has no authorization code");
	// New registrations receive their issued client ID on the callback.
	const clientId = attempt.clientId === "dynamic_agent_client" ? query.get("client_id") : attempt.clientId;
	if (!clientId?.startsWith("oaiapp_")) throw new AuthError("Callback did not include an issued client ID");

	const tokens = await tokenRequest({
		grant_type: "authorization_code",
		code,
		client_id: clientId,
		code_verifier: attempt.verifier,
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
	});
	if (!tokens.id_token || !tokens.refresh_token) throw new AuthError("Token response is missing an ID or refresh token");

	// ponytail: the ID token came straight from OpenAI's token endpoint over TLS, which
	// OIDC Core 3.1.3.7 accepts in place of a signature check. It is only read for
	// the nonce and the email shown in the UI; access is decided by the access token.
	const claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
		nonce?: string;
		aud?: string | string[];
		email?: string;
	};
	if (claims.nonce !== attempt.nonce) throw new AuthError("ID token nonce does not match");
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(clientId)) throw new AuthError("ID token audience does not match");

	const scopes = (tokens.scope ?? "").split(/[\s+]+/).filter(Boolean);
	if (!scopes.includes(PLAN_SCOPE)) {
		throw new AuthError("ChatGPT plan usage was not granted. It needs a Plus or Pro plan.");
	}

	saveTokens(c, tokens, { clientId, expiresAt: 0 }, typeof claims.email === "string" ? claims.email : undefined);
	log.info("completeLogin — signed in");
	return { email: claims.email };
}

// One refresh per refresh token: concurrent requests from the same browser must not
// both rotate it, or the second use revokes the whole token family. Only signed
// sessions get here, so the map holds real users' refreshes.
const refreshing = new Map<string, Promise<TokenResponse>>();

/**
 * This request's ChatGPT access token, refreshed when within `minValidMs` of expiry
 * (rotated tokens go back to the browser as cookies). Returns null when signed out.
 */
export async function getAccessToken(c: Context, minValidMs = 5 * 60_000): Promise<string | null> {
	const session = readSession((n) => getCookie(c, n));
	if (!session) return null;
	const { accessToken, refreshToken, meta } = session;

	const now = Date.now();
	const due = now > meta.expiresAt - minValidMs;
	const allowed = !meta.earliestRefreshAt || now >= meta.earliestRefreshAt;
	if (!due || (!allowed && now < meta.expiresAt)) return accessToken;

	let flight = refreshing.get(refreshToken);
	if (!flight) {
		flight = tokenRequest({
			grant_type: "refresh_token",
			client_id: meta.clientId,
			refresh_token: refreshToken,
			resource: RESOURCE,
		});
		refreshing.set(refreshToken, flight);
		// Keep a success briefly so requests already in flight with the old cookie reuse it.
		flight.then(
			() => setTimeout(() => refreshing.delete(refreshToken), 60_000).unref(),
			() => refreshing.delete(refreshToken),
		);
	}
	try {
		return saveTokens(c, await flight, { ...meta, refreshToken }).accessToken;
	} catch (err) {
		if (err instanceof AuthError && UNUSABLE_REFRESH.has(err.code ?? "")) {
			log.warn(`getAccessToken — refresh rejected (${err.code}), signing out`);
			clearTokens(c);
			return null;
		}
		throw err;
	}
}

export async function status(c: Context, minValidMs?: number) {
	const token = await getAccessToken(c, minValidMs);
	if (!token) return { signedIn: false as const };
	const meta = readSession((n) => getCookie(c, n))?.meta;
	return { signedIn: true as const, email: meta?.email, expiresAt: meta?.expiresAt };
}

export async function logout(c: Context): Promise<void> {
	const session = readSession((n) => getCookie(c, n));
	clearTokens(c);
	if (session) {
		const { refreshToken, meta } = session;
		// Best effort: the browser's cookies are already gone.
		await fetch(revokeUrl, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: meta.clientId }),
			signal: AbortSignal.timeout(15_000),
		}).catch(() => {});
	}
}

/** Reads the access token from a raw Cookie header (WebSocket upgrades bypass Hono). */
export function accessTokenFromCookieHeader(header: string | undefined): { token: string; expiresAt: number } | null {
	if (!header) return null;
	const cookies = new Map(
		header.split(";").map((part) => {
			const i = part.indexOf("=");
			return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())] as const;
		}),
	);
	const session = readSession((n) => cookies.get(n));
	return session ? { token: session.accessToken, expiresAt: session.meta.expiresAt } : null;
}
