import { createHash, randomBytes, randomUUID } from "node:crypto";
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

// Stable, non-secret host ID for this 3Roads install (OpenAI asks for a persistent one).
const HOST_FILE =
	process.env.CHATGPT_HOST_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "../../../../data/chatgpt-host.json");
let hostId: string | undefined;
function getHostId(): string {
	if (hostId) return hostId;
	if (existsSync(HOST_FILE)) hostId = (JSON.parse(readFileSync(HOST_FILE, "utf8")) as { hostId: string }).hostId;
	else {
		hostId = `urn:uuid:${randomUUID()}`;
		writeFileSync(HOST_FILE, JSON.stringify({ hostId }));
	}
	return hostId;
}

// Pending sign-ins, keyed by OAuth state. PKCE verifier and nonce stay server-side.
// ponytail: in-memory, a restart mid-sign-in just means signing in again.
const pending = new Map<
	string,
	{ verifier: string; nonce: string; clientId: string; browser: string; createdAt: number }
>();
const PENDING_TTL = 10 * 60_000;

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

function readMeta(raw: string | undefined): Meta | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Meta;
	} catch {
		return undefined;
	}
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
	const now = Date.now();
	for (const [key, value] of pending) if (now - value.createdAt > PENDING_TTL) pending.delete(key);

	const verifier = b64url(randomBytes(32));
	const state = b64url(randomBytes(24));
	const nonce = b64url(randomBytes(24));
	const browser = b64url(randomBytes(24));
	// Reuse this browser's issued client ID; first sign-in registers through the dynamic entrypoint.
	const clientId = readMeta(getCookie(c, META))?.clientId ?? "dynamic_agent_client";

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
		params.set("ext_agent_host_id", getHostId());
	}
	pending.set(state, { verifier, nonce, clientId, browser, createdAt: now });
	// Binds the pasted callback to the browser that started the sign-in.
	setCookie(c, LOGIN, browser, cookieOpts(c, PENDING_TTL / 1000));
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
	const attempt = pending.get(query.get("state") ?? "");
	if (!attempt || attempt.browser !== getCookie(c, LOGIN)) {
		throw new AuthError("Unknown or expired sign-in attempt. Start again.");
	}
	pending.delete(query.get("state") ?? "");
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
// both rotate it, or the second use revokes the whole token family.
const refreshing = new Map<string, Promise<{ tokens: TokenResponse; at: number }>>();

/**
 * This request's ChatGPT access token, refreshed when within `minValidMs` of expiry
 * (rotated tokens go back to the browser as cookies). Returns null when signed out.
 */
export async function getAccessToken(c: Context, minValidMs = 5 * 60_000): Promise<string | null> {
	const accessToken = getCookie(c, AT);
	const refreshToken = getCookie(c, RT);
	const meta = readMeta(getCookie(c, META));
	if (!accessToken || !refreshToken || !meta) return null;

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
		}).then((tokens) => ({ tokens, at: Date.now() }));
		refreshing.set(refreshToken, flight);
		// Keep the result briefly so requests already in flight with the old cookie reuse it.
		flight.finally(() => setTimeout(() => refreshing.delete(refreshToken), 60_000).unref()).catch(() => {});
	}
	try {
		const { tokens } = await flight;
		return saveTokens(c, tokens, { ...meta, refreshToken }).accessToken;
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
	const meta = readMeta(getCookie(c, META));
	return { signedIn: true as const, email: meta?.email, expiresAt: meta?.expiresAt };
}

export async function logout(c: Context): Promise<void> {
	const refreshToken = getCookie(c, RT);
	const meta = readMeta(getCookie(c, META));
	clearTokens(c);
	if (refreshToken && meta) {
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
	const token = cookies.get(AT);
	const meta = readMeta(cookies.get(META));
	return token && meta ? { token, expiresAt: meta.expiresAt } : null;
}
