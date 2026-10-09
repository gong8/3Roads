import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Fixtures only: no network, no repo data dir.
process.env.CHATGPT_HOST_FILE = join(mkdtempSync(join(tmpdir(), "3roads-auth-")), "host.json");
const { authRoutes } = await import("../routes/auth.js");
const { streamResponse } = await import("./llm-chat.js");
const { getAccessToken } = await import("./chatgpt-auth.js");
const { Hono } = await import("hono");

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const realFetch = globalThis.fetch;

function cookiesFrom(res: Response): Map<string, string> {
	const jar = new Map<string, string>();
	for (const line of res.headers.getSetCookie()) {
		const [pair] = line.split(";");
		const i = pair.indexOf("=");
		jar.set(pair.slice(0, i), pair.slice(i + 1));
	}
	return jar;
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

test("sign-in: pasted callback is bound to the starting browser and lands tokens in HttpOnly cookies", async (t) => {
	let tokenBody = undefined as URLSearchParams | undefined;
	let exchanges = 0;
	let nonce = "";
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		exchanges++;
		tokenBody = new URLSearchParams(String(init.body));
		const idToken = `x.${b64({ nonce, aud: "oaiapp_123", email: "a@b.c" })}.sig`;
		return Response.json({
			access_token: "at-1",
			refresh_token: "rt-1",
			id_token: idToken,
			expires_in: 3600,
			scope: "openid email offline_access resource.invoke chatgpt.tokens.use.direct",
		});
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});

	const start = await authRoutes.request("/chatgpt/start", { method: "POST" });
	const { url } = (await start.json()) as { url: string };
	const authorize = new URL(url);
	assert.equal(authorize.searchParams.get("client_id"), "dynamic_agent_client");
	assert.equal(authorize.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	nonce = authorize.searchParams.get("nonce") ?? "";
	const state = authorize.searchParams.get("state");
	const callback = `http://127.0.0.1:1455/auth/callback?code=c1&state=${state}&client_id=oaiapp_123`;
	const loginJar = cookiesFrom(start);
	assert.match(start.headers.getSetCookie().find((l) => l.startsWith("cg_login=")) ?? "", /HttpOnly/);

	// Another browser (without the sign-in cookie) pasting the same URL is rejected.
	for (const cookie of ["", `cg_login=${b64({ state: "other", verifier: "v", nonce: "n", clientId: "x" })}`]) {
		const stranger = await authRoutes.request("/chatgpt/complete", {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ url: callback }),
		});
		assert.equal(stranger.status, 400);
	}
	assert.equal(exchanges, 0);

	// The browser that started it can finish.
	const done = await authRoutes.request("/chatgpt/complete", {
		method: "POST",
		headers: { "content-type": "application/json", cookie: cookieHeader(loginJar) },
		body: JSON.stringify({ url: callback }),
	});
	assert.equal(done.status, 200, await done.clone().text());
	assert.equal(tokenBody?.get("code"), "c1");
	assert.equal(tokenBody?.get("client_id"), "oaiapp_123");
	assert.ok(tokenBody?.get("code_verifier"));
	for (const line of done.headers.getSetCookie().filter((l) => /^cg_(at|rt|meta)=/.test(l))) {
		assert.match(line, /HttpOnly/);
		assert.match(line, /SameSite=Strict/);
	}
	const jar = cookiesFrom(done);
	assert.equal(jar.get("cg_at"), "at-1");
	assert.equal(jar.get("cg_rt"), "rt-1");
});

/** Runs a full sign-in against a fake token endpoint and returns the session cookies. */
async function signIn(): Promise<Map<string, string>> {
	let nonce = "";
	globalThis.fetch = (async () =>
		Response.json({
			access_token: "at-1",
			refresh_token: "rt-1",
			id_token: `x.${b64({ nonce, aud: "oaiapp_123" })}.sig`,
			expires_in: 3600,
			scope: "chatgpt.tokens.use.direct",
		})) as typeof fetch;
	const start = await authRoutes.request("/chatgpt/start", { method: "POST" });
	const url = new URL(((await start.json()) as { url: string }).url);
	nonce = url.searchParams.get("nonce") ?? "";
	const done = await authRoutes.request("/chatgpt/complete", {
		method: "POST",
		headers: { "content-type": "application/json", cookie: cookieHeader(cookiesFrom(start)) },
		body: JSON.stringify({
			url: `http://127.0.0.1:1455/auth/callback?code=c&state=${url.searchParams.get("state")}&client_id=oaiapp_123`,
		}),
	});
	assert.equal(done.status, 200);
	return cookiesFrom(done);
}

test("refresh: one rotation for concurrent requests, and unsigned cookies never reach OpenAI", async (t) => {
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const jar = await signIn();
	// Force a refresh by asking for more validity than the token has left.
	const app = new Hono().get("/", async (c) => c.text((await getAccessToken(c, 2 * 3600_000)) ?? "none"));

	let refreshes = 0;
	globalThis.fetch = (async () => {
		refreshes++;
		await new Promise((r) => setTimeout(r, 20));
		return Response.json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
	}) as typeof fetch;
	const cookie = cookieHeader(jar);
	const results = await Promise.all([1, 2, 3].map(() => app.request("/", { headers: { cookie } })));
	assert.deepEqual(await Promise.all(results.map((r) => r.text())), ["at-2", "at-2", "at-2"]);
	assert.equal(refreshes, 1);
	assert.equal(cookiesFrom(results[0]).get("cg_rt"), "rt-2");

	// Made-up, tampered or swapped cookies are treated as signed out with no outbound request.
	refreshes = 0;
	const forged = new Map(jar);
	forged.set("cg_rt", "attacker-token");
	const unsigned = `cg_at=a; cg_rt=r; cg_meta=${b64({ clientId: "oaiapp_123", expiresAt: 0 })}`;
	for (const bad of [cookieHeader(forged), unsigned, ""]) {
		const res = await app.request("/", { headers: { cookie: bad } });
		assert.equal(await res.text(), "none");
	}
	assert.equal(refreshes, 0);
});

test("responses: plan-usage request shape and tool-call stream parsing", async () => {
	const sse = (events: object[]) =>
		new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	let body: Record<string, any> = {};
	let auth = "";
	const fakeFetch = (async (_url: string, init: RequestInit) => {
		body = JSON.parse(String(init.body));
		auth = new Headers(init.headers).get("authorization") ?? "";
		return sse([
			{ type: "response.output_text.delta", delta: "Saving." },
			{
				type: "response.output_item.done",
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "mcp__3roads__save_tossups_batch", arguments: "{}" },
			},
			{ type: "response.completed", response: {} },
		]);
	}) as typeof fetch;

	const tools = [{ type: "namespace" as const, name: "threeroads", description: "d", tools: [] }];
	const out = await streamResponse({
		token: "at-1",
		model: "gpt-test",
		instructions: "be a judge",
		input: [{ role: "user", content: "hi" }],
		tools,
		fetch: fakeFetch,
	});
	assert.equal(auth, "Bearer at-1");
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	assert.equal(body.instructions, "be a judge");
	assert.ok(!body.input.some((i: { role?: string }) => i.role === "system"));
	for (const forbidden of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user"]) {
		assert.equal(body[forbidden], undefined, forbidden);
	}
	assert.equal(body.tools[0].type, "namespace");
	assert.equal(out.content, "Saving.");
	assert.deepEqual(out.calls, [{ call_id: "call_1", name: "mcp__3roads__save_tossups_batch", arguments: "{}" }]);

	// A stream that ends without response.completed is a failure, not an empty success.
	const truncated = (async () => sse([{ type: "response.output_text.delta", delta: "par" }])) as typeof fetch;
	await assert.rejects(
		streamResponse({ token: "t", model: "m", instructions: "i", input: [], tools: [], fetch: truncated }),
		/before response.completed/,
	);
});
