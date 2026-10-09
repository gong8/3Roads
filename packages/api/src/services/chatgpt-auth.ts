import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, getDb } from "@3roads/shared";

// "Sign in with ChatGPT" (open-source flow), connected per 3Roads user for inference:
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//
// Like monster, the grant is stored server-side (ChatGPTConnection, in the owner-only
// database) and refreshed here, so long games and background generation keep working.
// The flow only allows a 127.0.0.1 callback, so the user pastes the URL their browser
// lands on back into 3Roads, which finishes the exchange.

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

export class AuthError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
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

// One sign-in in progress per user; only signed-in (allowlisted) users reach this.
const PENDING_TTL = 10 * 60_000;
const pending = new Map<string, { state: string; verifier: string; nonce: string; clientId: string; createdAt: number }>();

function parseEarliest(value: TokenResponse["earliest_refresh_at"]): Date | null {
	if (value == null) return null;
	const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms) : null;
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

/** Starts connecting ChatGPT for this user; returns the OpenAI URL to open. */
export async function beginLogin(userId: string): Promise<string> {
	const existing = await getDb().chatGPTConnection.findUnique({ where: { userId } });
	// Reuse the issued client ID; the first sign-in registers through the dynamic entrypoint.
	const clientId = existing?.clientId ?? "dynamic_agent_client";
	const verifier = b64url(randomBytes(32));
	const state = b64url(randomBytes(24));
	const nonce = b64url(randomBytes(24));

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
	pending.set(userId, { state, verifier, nonce, clientId, createdAt: Date.now() });
	return `${authorizeUrl}?${params}`;
}

/** Finishes connecting ChatGPT from the callback URL the user pasted. */
export async function completeLogin(userId: string, pastedUrl: string): Promise<{ email?: string }> {
	let query: URLSearchParams;
	try {
		query = new URL(pastedUrl.trim()).searchParams;
	} catch {
		throw new AuthError("That doesn't look like a URL. Paste the whole address from the address bar.");
	}
	const attempt = pending.get(userId);
	if (!attempt || attempt.state !== query.get("state") || Date.now() - attempt.createdAt > PENDING_TTL) {
		throw new AuthError("Unknown or expired sign-in attempt. Start again.");
	}
	pending.delete(userId);

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
	// OIDC Core 3.1.3.7 accepts in place of a signature check. It is only read for the
	// nonce and the email shown in settings; 3Roads identity comes from Clerk.
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

	const data = {
		clientId,
		email: typeof claims.email === "string" ? claims.email : null,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
		earliestRefreshAt: parseEarliest(tokens.earliest_refresh_at),
	};
	await getDb().chatGPTConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });
	log.info(`completeLogin — connected ChatGPT for user ${userId}`);
	return { email: data.email ?? undefined };
}

// One refresh per user at a time: a second concurrent refresh would reuse the rotated
// refresh token, which revokes the whole token family.
const refreshing = new Map<string, Promise<string | null>>();

/** A valid access token for this user's ChatGPT plan, or null if not connected. */
export async function getAccessToken(userId: string): Promise<string | null> {
	const conn = await getDb().chatGPTConnection.findUnique({ where: { userId } });
	if (!conn) return null;
	const now = Date.now();
	const due = now > conn.expiresAt.getTime() - 5 * 60_000;
	const allowed = !conn.earliestRefreshAt || now >= conn.earliestRefreshAt.getTime();
	if (!due || (!allowed && now < conn.expiresAt.getTime())) return conn.accessToken;

	let flight = refreshing.get(userId);
	if (!flight) {
		flight = (async () => {
			try {
				const tokens = await tokenRequest({
					grant_type: "refresh_token",
					client_id: conn.clientId,
					refresh_token: conn.refreshToken,
					resource: RESOURCE,
				});
				await getDb().chatGPTConnection.update({
					where: { userId },
					data: {
						accessToken: tokens.access_token,
						refreshToken: tokens.refresh_token ?? conn.refreshToken,
						expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
						earliestRefreshAt: parseEarliest(tokens.earliest_refresh_at),
					},
				});
				return tokens.access_token;
			} catch (err) {
				if (err instanceof AuthError && UNUSABLE_REFRESH.has(err.code ?? "")) {
					log.warn(`getAccessToken — refresh rejected (${err.code}) for user ${userId}, disconnecting`);
					await getDb().chatGPTConnection.delete({ where: { userId } }).catch(() => {});
					return null;
				}
				throw err;
			} finally {
				refreshing.delete(userId);
			}
		})();
		refreshing.set(userId, flight);
	}
	return flight;
}

export async function connectionStatus(userId: string) {
	const conn = await getDb().chatGPTConnection.findUnique({ where: { userId }, select: { email: true } });
	return conn ? { connected: true as const, email: conn.email ?? undefined } : { connected: false as const };
}

export async function disconnect(userId: string): Promise<void> {
	const conn = await getDb().chatGPTConnection.findUnique({ where: { userId } });
	if (!conn) return;
	await getDb().chatGPTConnection.delete({ where: { userId } });
	// Best effort: our copy is already gone.
	await fetch(revokeUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token: conn.refreshToken, token_type_hint: "refresh_token", client_id: conn.clientId }),
		signal: AbortSignal.timeout(15_000),
	}).catch(() => {});
}
