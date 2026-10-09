import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Fixtures only: a throwaway SQLite database, a locally generated Clerk-style signing
// key, and stubbed OpenAI endpoints. No network, no repo data.
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const tmp = mkdtempSync(join(tmpdir(), "3roads-test-"));
process.env.DATABASE_URL = `file:${join(tmp, "test.db")}`;
process.env.CHATGPT_HOST_FILE = join(tmp, "host.json");
execFileSync(join(root, "node_modules/.bin/prisma"), ["db", "push", "--skip-generate", "--schema", join(root, "prisma/schema.prisma")], {
	env: process.env,
	stdio: "ignore",
});

const ORIGIN = "http://localhost:7003";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.CLERK_JWT_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.CLERK_AUTHORIZED_PARTIES = ORIGIN;

const { Hono } = await import("hono");
const { getDb } = await import("@3roads/shared");
const { requireUser } = await import("./services/user-auth.js");
const { setsRoutes } = await import("./routes/sets.js");
const { meRoutes } = await import("./routes/me.js");
const { getAccessToken } = await import("./services/chatgpt-auth.js");
const { runLlmChat, streamResponse } = await import("./services/llm-chat.js");

const api = new Hono();
api.use("*", requireUser);
api.route("/sets", setsRoutes);
api.route("/me", meRoutes);

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sessionToken(sub: string, key = privateKey) {
	const now = Math.floor(Date.now() / 1000);
	const head = b64({ alg: "RS256", typ: "JWT", kid: "test" });
	const body = b64({ sub, azp: ORIGIN, iat: now, nbf: now - 5, exp: now + 60, email: `${sub}@example.com` });
	const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
	return `${head}.${body}.${sig}`;
}
const as = (sub: string) => ({ authorization: `Bearer ${sessionToken(sub)}` });
const realFetch = globalThis.fetch;

test("auth: every route needs a valid session; forged tokens are refused", async () => {
	assert.equal((await api.request("/sets")).status, 401);
	const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
	assert.equal((await api.request("/sets", { headers: { authorization: `Bearer ${sessionToken("u_x", other)}` } })).status, 401);
	const me = await api.request("/me", { headers: as("u_alice") });
	assert.equal(me.status, 200);
	assert.deepEqual(await me.json(), { id: "u_alice", email: "u_alice@example.com" });
});

test("sets: public pool by default, private hidden from others, only owners change or delete", async () => {
	await api.request("/me", { headers: as("u_bob") }); // creates the user row
	const db = getDb();
	const pub = await db.questionSet.create({ data: { name: "pub", theme: "t", ownerId: "u_alice" } });
	const priv = await db.questionSet.create({ data: { name: "priv", theme: "t", ownerId: "u_alice", isPrivate: true } });

	const bobList = (await (await api.request("/sets", { headers: as("u_bob") })).json()) as { id: string; mine: boolean }[];
	assert.ok(bobList.some((s) => s.id === pub.id && !s.mine));
	assert.ok(!bobList.some((s) => s.id === priv.id));
	assert.equal((await api.request(`/sets/${priv.id}`, { headers: as("u_bob") })).status, 404);

	const json = { "content-type": "application/json" };
	assert.equal((await api.request(`/sets/${pub.id}`, { method: "DELETE", headers: as("u_bob") })).status, 404);
	assert.equal(
		(await api.request(`/sets/${pub.id}`, { method: "PATCH", headers: { ...as("u_bob"), ...json }, body: JSON.stringify({ isPrivate: true }) })).status,
		404,
	);
	assert.equal(
		(await api.request(`/sets/${pub.id}`, { method: "PATCH", headers: { ...as("u_alice"), ...json }, body: JSON.stringify({ isPrivate: true }) })).status,
		200,
	);
	assert.equal((await api.request(`/sets/${pub.id}`, { headers: as("u_bob") })).status, 404);
	assert.equal((await api.request(`/sets/${pub.id}`, { method: "DELETE", headers: as("u_alice") })).status, 200);
	assert.equal(await db.questionSet.count({ where: { id: pub.id } }), 0);
});

test("chatgpt: connect stores the grant server-side; refresh rotates once; bad state is refused", async (t) => {
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	let nonce = "";
	let exchanges = 0;
	globalThis.fetch = (async () => {
		exchanges++;
		return Response.json({
			access_token: "at-1",
			refresh_token: "rt-1",
			id_token: `x.${b64({ nonce, aud: "oaiapp_123", email: "carol@chatgpt" })}.sig`,
			expires_in: 3600,
			scope: "openid offline_access chatgpt.tokens.use.direct",
		});
	}) as typeof fetch;

	const start = await api.request("/me/chatgpt/start", { method: "POST", headers: as("u_carol") });
	const url = new URL(((await start.json()) as { url: string }).url);
	assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
	assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
	nonce = url.searchParams.get("nonce") ?? "";
	const callback = `http://127.0.0.1:1455/auth/callback?code=c1&state=${url.searchParams.get("state")}&client_id=oaiapp_123`;
	const post = (who: string, body: object) =>
		api.request("/me/chatgpt/complete", {
			method: "POST",
			headers: { ...as(who), "content-type": "application/json" },
			body: JSON.stringify(body),
		});

	// Another user pasting Carol's callback, or a wrong state, gets nowhere.
	assert.equal((await post("u_dave", { url: callback })).status, 400);
	assert.equal((await post("u_carol", { url: callback.replace(/state=[^&]+/, "state=nope") })).status, 400);
	assert.equal(exchanges, 0);

	// A fresh start replaces Carol's pending sign-in.
	const start2 = await api.request("/me/chatgpt/start", { method: "POST", headers: as("u_carol") });
	const url2 = new URL(((await start2.json()) as { url: string }).url);
	nonce = url2.searchParams.get("nonce") ?? "";
	const ok = await post("u_carol", {
		url: `http://127.0.0.1:1455/auth/callback?code=c2&state=${url2.searchParams.get("state")}&client_id=oaiapp_123`,
	});
	assert.equal(ok.status, 200, await ok.clone().text());
	const conn = await getDb().chatGPTConnection.findUnique({ where: { userId: "u_carol" } });
	assert.equal(conn?.refreshToken, "rt-1");
	assert.equal(conn?.clientId, "oaiapp_123");

	// Near expiry, concurrent callers share one refresh and the DB gets the rotated token.
	await getDb().chatGPTConnection.update({ where: { userId: "u_carol" }, data: { expiresAt: new Date(Date.now() + 1000) } });
	let refreshes = 0;
	globalThis.fetch = (async () => {
		refreshes++;
		await new Promise((r) => setTimeout(r, 20));
		return Response.json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
	}) as typeof fetch;
	assert.deepEqual(await Promise.all([1, 2, 3].map(() => getAccessToken("u_carol"))), ["at-2", "at-2", "at-2"]);
	assert.equal(refreshes, 1);
	assert.equal((await getDb().chatGPTConnection.findUnique({ where: { userId: "u_carol" } }))?.refreshToken, "rt-2");

	// A revoked grant disconnects instead of failing forever.
	await getDb().chatGPTConnection.update({ where: { userId: "u_carol" }, data: { expiresAt: new Date(0) } });
	globalThis.fetch = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;
	assert.equal(await getAccessToken("u_carol"), null);
	assert.equal(await getDb().chatGPTConnection.count({ where: { userId: "u_carol" } }), 0);
});

const sse = (events: object[]) =>
	new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});

test("generation: save tools write only into the run's own set, whatever setId the model names", async (t) => {
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const db = getDb();
	await db.user.upsert({ where: { id: "u_erin" }, create: { id: "u_erin" }, update: {} });
	await db.chatGPTConnection.create({
		data: { userId: "u_erin", clientId: "oaiapp_1", accessToken: "at-e", refreshToken: "rt-e", expiresAt: new Date(Date.now() + 3_600_000) },
	});
	const mine = await db.questionSet.create({ data: { name: "mine", theme: "t", ownerId: "u_erin" } });
	const victim = await db.questionSet.create({ data: { name: "victim", theme: "t", ownerId: "u_alice" } });

	const tossup = { question: "q", answer: "a", category: "c", subcategory: "s", difficulty: "d" };
	const turns = [
		sse([
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					call_id: "call_1",
					name: "mcp__3roads__save_tossups_batch",
					arguments: JSON.stringify({ setId: victim.id, tossups: [tossup] }),
				},
			},
			{ type: "response.completed", response: {} },
		]),
		sse([{ type: "response.output_text.delta", delta: "done" }, { type: "response.completed", response: {} }]),
	];
	const auths: string[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		auths.push(new Headers(init.headers).get("authorization") ?? "");
		return turns.shift() ?? sse([{ type: "response.completed", response: {} }]);
	}) as typeof fetch;

	const result = await runLlmChat({ userId: "u_erin", setId: mine.id, prompt: "p", systemPrompt: "s" });
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(auths, ["Bearer at-e", "Bearer at-e"]);
	assert.equal(await db.tossup.count({ where: { setId: mine.id } }), 1);
	assert.equal(await db.tossup.count({ where: { setId: victim.id } }), 0);

	// Not connected: a clear error, no request to OpenAI.
	auths.length = 0;
	const unconnected = await runLlmChat({ userId: "u_nobody", setId: mine.id, prompt: "p", systemPrompt: "s" });
	assert.equal(unconnected.ok, false);
	assert.match(unconnected.error ?? "", /not connected/);
	assert.equal(auths.length, 0);
});

test("responses: plan-usage request shape and truncated-stream rejection", async () => {
	let body: Record<string, any> = {};
	const fakeFetch = (async (_url: string, init: RequestInit) => {
		body = JSON.parse(String(init.body));
		return sse([
			{ type: "response.output_text.delta", delta: "ok" },
			{ type: "response.completed", response: {} },
		]);
	}) as typeof fetch;
	const out = await streamResponse({
		token: "t",
		model: "gpt-test",
		instructions: "be a judge",
		input: [{ role: "user", content: "hi" }],
		tools: [],
		fetch: fakeFetch,
	});
	assert.equal(out.content, "ok");
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	assert.equal(body.instructions, "be a judge");
	for (const forbidden of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user"]) {
		assert.equal(body[forbidden], undefined, forbidden);
	}
	const truncated = (async () => sse([{ type: "response.output_text.delta", delta: "par" }])) as typeof fetch;
	await assert.rejects(
		streamResponse({ token: "t", model: "m", instructions: "i", input: [], tools: [], fetch: truncated }),
		/before response.completed/,
	);
});

test("rooms: a dropped seat goes back only to the same account, not to anyone using the name", async () => {
	const { createRoom, disconnectPlayer, reconnectPlayer, activeRooms } = await import("./game/rooms.js");
	const { socketUsers } = await import("./game/socket-users.js");
	type Ws = Parameters<typeof createRoom>[3];
	const sock = (userId: string) => {
		const ws = { send() {}, readyState: 1 } as unknown as Ws;
		socketUsers.set(ws, userId);
		return ws;
	};
	const packet = {
		name: "p",
		tossups: [{ id: "t1", question: "q", answer: "a", powerMarkIndex: null, category: "c", subcategory: "s", difficulty: "d" }],
		bonuses: [],
	};
	const { room, playerId } = await createRoom(undefined, "alice", "ffa", sock("u_alice"), false, false, undefined, undefined, packet);
	disconnectPlayer(room.code, playerId);

	assert.equal(reconnectPlayer(room.code, "alice", sock("u_mallory")), null);
	const back = reconnectPlayer(room.code, "alice", sock("u_alice"));
	assert.equal(back?.playerId, playerId);
	assert.equal(room.players.get(playerId)?.isModerator, true);
	activeRooms.delete(room.code);
});
