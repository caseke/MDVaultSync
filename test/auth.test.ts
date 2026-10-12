import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
	AuthClient,
	AuthError,
	REDIRECT_NATIVE,
	REDIRECT_PROTOCOL,
	SCOPE,
	type AuthStatus,
} from "../src/remote/auth.ts";
import { challengeFromVerifier } from "../src/remote/pkce.ts";
import type { TokenStore } from "../src/core/ports.ts";
import { FakeClock, FakeHttp, bytes, deferred, formOf, jsonResponse } from "./fakes/fake-http.ts";

const CLIENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

class MemoryTokenStore implements TokenStore {
	value: string | null = null;
	readonly backend = "secret-storage" as const;
	readonly log: string[] = [];
	get(): string | null {
		return this.value;
	}
	async set(rt: string): Promise<void> {
		await Promise.resolve();
		this.value = rt;
		this.log.push(`set:${rt}`);
	}
	async clear(): Promise<void> {
		await Promise.resolve();
		this.value = null;
		this.log.push("clear");
	}
}

function tokenBody(over: Record<string, unknown> = {}) {
	return { token_type: "Bearer", scope: SCOPE, expires_in: 3600, access_token: "AT1", refresh_token: "RT1", ...over };
}

function setup(clientId = CLIENT_ID) {
	const http = new FakeHttp();
	const tokens = new MemoryTokenStore();
	const clock = new FakeClock();
	const auth = new AuthClient({ transport: http, tokens, clock, getClientId: () => clientId });
	const statuses: AuthStatus[] = [];
	auth.onStatusChange((s) => statuses.push(s));
	return { http, tokens, clock, auth, statuses };
}

async function startSignIn(auth: AuthClient, redirect: string = REDIRECT_PROTOCOL) {
	const url = new URL(await auth.buildAuthorizeUrl(redirect as typeof REDIRECT_PROTOCOL));
	return { url, state: url.searchParams.get("state") ?? "" };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		assert.ok(e instanceof AuthError, `expected AuthError, got ${String(e)}`);
		return e.code;
	}
	return "resolved";
}

describe("authorize URL", () => {
	test("targets the /consumers authorize endpoint with exact scope and S256", async () => {
		const { auth } = setup();
		const { url } = await startSignIn(auth);
		assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
		const p = url.searchParams;
		assert.equal(p.get("scope"), "Files.ReadWrite.AppFolder offline_access");
		assert.equal(SCOPE, "Files.ReadWrite.AppFolder offline_access");
		assert.equal(p.get("client_id"), CLIENT_ID);
		assert.equal(p.get("response_type"), "code");
		assert.equal(p.get("response_mode"), "query");
		assert.equal(p.get("code_challenge_method"), "S256");
		assert.match(p.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
		assert.match(p.get("state") ?? "", /^[A-Za-z0-9_-]{43}$/);
		assert.equal(p.get("redirect_uri"), "obsidian://mdvaultsync-auth");
		assert.equal(p.get("prompt"), "select_account");
		assert.equal(p.get("client_secret"), null);
	});

	test("uses the nativeclient redirect for the paste fallback", async () => {
		const { auth } = setup();
		const { url } = await startSignIn(auth, REDIRECT_NATIVE);
		assert.equal(url.searchParams.get("redirect_uri"), "https://login.microsoftonline.com/common/oauth2/nativeclient");
	});

	test("refuses a missing or malformed client ID", async () => {
		for (const id of ["", "not-a-guid", `${CLIENT_ID}&scope=Files.ReadWrite.All`]) {
			const { auth } = setup(id);
			assert.equal(await codeOf(auth.buildAuthorizeUrl(REDIRECT_PROTOCOL)), "no-client-id");
		}
	});
});

describe("callback checks", () => {
	test("rejects a callback when no sign-in is pending", async () => {
		const { auth, http } = setup();
		assert.equal(await codeOf(auth.handleCallback({ code: "C", state: "S" }, "protocol")), "no-pending");
		assert.equal(http.requests.length, 0);
	});

	test("rejects a wrong state but keeps the real sign-in pending", async () => {
		const { auth, http, tokens } = setup();
		const { state } = await startSignIn(auth);
		assert.equal(await codeOf(auth.handleCallback({ code: "EVIL", state: "x".repeat(43) }, "protocol")), "state-mismatch");
		assert.equal(await codeOf(auth.handleCallback({ code: "EVIL" }, "protocol")), "state-mismatch");
		assert.equal(http.requests.length, 0);
		http.enqueueJson(200, tokenBody());
		await auth.handleCallback({ code: "GOOD", state }, "protocol");
		assert.equal(formOf(http.requests[0]!).get("code"), "GOOD");
		assert.equal(tokens.value, "RT1");
	});

	test("rejects an expired sign-in (over 10 minutes) and accepts one just under", async () => {
		{
			const { auth, clock } = setup();
			const { state } = await startSignIn(auth);
			clock.advance(10 * 60_000 + 1);
			assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "expired");
			// Expiry consumes the pending sign-in.
			assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "no-pending");
		}
		{
			const { auth, clock, http } = setup();
			const { state } = await startSignIn(auth);
			clock.advance(9 * 60_000 + 59_000);
			http.enqueueJson(200, tokenBody());
			await auth.handleCallback({ code: "C", state }, "protocol");
			assert.equal(auth.status, "signed-in");
		}
	});

	test("rejects a reused state", async () => {
		const { auth, http } = setup();
		const { state } = await startSignIn(auth);
		http.enqueueJson(200, tokenBody());
		await auth.handleCallback({ code: "C", state }, "protocol");
		assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "no-pending");
		assert.equal(http.requests.length, 1);
	});

	test("two racing callbacks with the right state redeem once", async () => {
		const { auth, http } = setup();
		const { state } = await startSignIn(auth);
		http.enqueueJson(200, tokenBody());
		const results = await Promise.all([
			codeOf(auth.handleCallback({ code: "C", state }, "protocol")),
			codeOf(auth.handleCallback({ code: "C", state }, "protocol")),
		]);
		assert.deepEqual(results.sort(), ["no-pending", "resolved"]);
		assert.equal(http.requests.length, 1);
	});

	test("a callback must arrive on the channel the sign-in started with", async () => {
		{
			const { auth } = setup();
			const { state } = await startSignIn(auth, REDIRECT_NATIVE);
			assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "redirect-mismatch");
		}
		{
			const { auth } = setup();
			const { state } = await startSignIn(auth, REDIRECT_PROTOCOL);
			assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "paste")), "redirect-mismatch");
		}
	});

	test("an error parameter is surfaced as a code, never with error_description", async () => {
		const SENTINEL = "SENTINEL-DESCRIPTION-8f3a";
		const { auth, http } = setup();
		const { state } = await startSignIn(auth);
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
			mock.method(console, m, () => undefined),
		);
		let caught: unknown;
		try {
			await auth.handleCallback({ error: "access_denied", error_description: SENTINEL, state }, "protocol");
		} catch (e) {
			caught = e;
		}
		const logged = spies.flatMap((s) => s.mock.calls.flatMap((c) => c.arguments.map((a) => String(a))));
		for (const s of spies) s.mock.restore();
		assert.ok(caught instanceof AuthError);
		assert.equal(caught.code, "provider-error");
		assert.equal(caught.providerCode, "access_denied");
		const dump = `${String(caught)} ${JSON.stringify(caught)} ${caught.stack ?? ""} ${caught.message}`;
		assert.ok(!dump.includes(SENTINEL));
		assert.ok(!logged.join(" ").includes(SENTINEL));
		assert.equal(http.requests.length, 0);
		// The pending sign-in was consumed by the matching state.
		assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "no-pending");
	});

	test("a provider error code outside the allowed shape becomes 'other'", async () => {
		const { auth } = setup();
		const { state } = await startSignIn(auth);
		const e = await auth.handleCallback({ error: "<script>alert(1)</script>", state }, "protocol").catch((x: unknown) => x);
		assert.ok(e instanceof AuthError);
		assert.equal(e.providerCode, "other");
	});

	test("a matching state without a code is rejected", async () => {
		const { auth } = setup();
		const { state } = await startSignIn(auth);
		assert.equal(await codeOf(auth.handleCallback({ state }, "protocol")), "missing-code");
	});

	test("starting a new sign-in replaces the old pending state", async () => {
		const { auth } = setup();
		const first = await startSignIn(auth);
		await startSignIn(auth);
		assert.equal(await codeOf(auth.handleCallback({ code: "C", state: first.state }, "protocol")), "state-mismatch");
	});
});

describe("token redemption", () => {
	test("posts a form with the PKCE verifier, no secret, no Origin, no Authorization", async () => {
		const { auth, http, tokens, statuses } = setup();
		const { url, state } = await startSignIn(auth);
		http.enqueueJson(200, tokenBody());
		await auth.handleCallback({ code: "CODE", state }, "protocol");
		const req = http.requests[0]!;
		assert.equal(req.url, TOKEN_URL);
		assert.equal(req.method, "POST");
		const headerNames = Object.keys(req.headers ?? {}).map((h) => h.toLowerCase());
		assert.ok(!headerNames.includes("origin"));
		assert.ok(!headerNames.includes("authorization"));
		assert.equal(req.headers?.["Content-Type"], "application/x-www-form-urlencoded");
		const form = formOf(req);
		assert.equal(form.get("client_id"), CLIENT_ID);
		assert.equal(form.get("grant_type"), "authorization_code");
		assert.equal(form.get("code"), "CODE");
		assert.equal(form.get("redirect_uri"), REDIRECT_PROTOCOL);
		assert.equal(form.get("scope"), SCOPE);
		assert.equal(form.get("client_secret"), null);
		const verifier = form.get("code_verifier") ?? "";
		assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
		assert.equal(await challengeFromVerifier(verifier), url.searchParams.get("code_challenge"));
		assert.equal(tokens.value, "RT1");
		assert.equal(auth.status, "signed-in");
		assert.deepEqual(statuses, ["signed-in"]);
		// The access token from redemption is cached: no second request.
		assert.equal(await auth.getAccessToken(), "AT1");
		assert.equal(http.requests.length, 1);
	});

	test("the paste fallback redeems with the nativeclient redirect", async () => {
		const { auth, http } = setup();
		const { state } = await startSignIn(auth, REDIRECT_NATIVE);
		const params = auth.parsePastedUrl(
			`https://login.microsoftonline.com/common/oauth2/nativeclient?code=PASTED&state=${state}`,
		);
		http.enqueueJson(200, tokenBody());
		await auth.handleCallback(params, "paste");
		assert.equal(formOf(http.requests[0]!).get("redirect_uri"), REDIRECT_NATIVE);
		assert.equal(formOf(http.requests[0]!).get("code"), "PASTED");
	});

	const hostile: [string, () => ReturnType<typeof jsonResponse>][] = [
		["access_token not a string", () => jsonResponse(200, tokenBody({ access_token: 42 }))],
		["missing refresh_token", () => jsonResponse(200, tokenBody({ refresh_token: undefined }))],
		["empty access_token", () => jsonResponse(200, tokenBody({ access_token: "" }))],
		["token_type not Bearer", () => jsonResponse(200, tokenBody({ token_type: "MAC" }))],
		["expires_in too small", () => jsonResponse(200, tokenBody({ expires_in: 5 }))],
		["expires_in too large", () => jsonResponse(200, tokenBody({ expires_in: 10_000_000 }))],
		["expires_in a string", () => jsonResponse(200, tokenBody({ expires_in: "3600" }))],
		["an array", () => jsonResponse(200, [tokenBody()])],
		["not JSON", () => ({ status: 200, headers: {}, body: bytes("<html>") })],
		["oversized", () => jsonResponse(200, tokenBody({ pad: "x".repeat(70_000) }))],
	];
	for (const [name, respond] of hostile) {
		test(`rejects a token response with ${name} and stores nothing`, async () => {
			const { auth, http, tokens } = setup();
			const { state } = await startSignIn(auth);
			http.enqueue(respond);
			assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "invalid-response");
			assert.equal(tokens.value, null);
			assert.equal(auth.status, "signed-out");
		});
	}

	test("a token endpoint error surfaces its sanitized code", async () => {
		const { auth, http, tokens } = setup();
		const { state } = await startSignIn(auth);
		http.enqueueJson(400, { error: "invalid_grant", error_description: "SENTINEL-DESC" });
		const e = await auth.handleCallback({ code: "C", state }, "protocol").catch((x: unknown) => x);
		assert.ok(e instanceof AuthError);
		assert.equal(e.code, "token-request-failed");
		assert.equal(e.providerCode, "invalid_grant");
		assert.ok(!`${String(e)} ${JSON.stringify(e)} ${e.stack ?? ""}`.includes("SENTINEL-DESC"));
		assert.equal(tokens.value, null);
	});

	test("a network failure during redemption is a 'network' error", async () => {
		const { auth, http } = setup();
		const { state } = await startSignIn(auth);
		http.enqueueNetworkError();
		assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "network");
	});
});

describe("paste fallback URL", () => {
	test("accepts exactly the nativeclient URL", () => {
		const { auth } = setup();
		const p = auth.parsePastedUrl("  https://login.microsoftonline.com/common/oauth2/nativeclient?code=A&state=B  ");
		assert.equal(p["code"], "A");
		assert.equal(p["state"], "B");
	});

	const bad = [
		"https://evil.com/common/oauth2/nativeclient?code=A&state=B",
		"http://login.microsoftonline.com/common/oauth2/nativeclient?code=A&state=B",
		"https://login.microsoftonline.com/consumers/oauth2/nativeclient?code=A&state=B",
		"https://login.microsoftonline.com/common/oauth2/nativeclient/x?code=A&state=B",
		"https://login.microsoftonline.com.evil.com/common/oauth2/nativeclient?code=A&state=B",
		"https://login.microsoftonline.com:8443/common/oauth2/nativeclient?code=A&state=B",
		"https://user@login.microsoftonline.com/common/oauth2/nativeclient?code=A&state=B",
		"obsidian://mdvaultsync-auth?code=A&state=B",
		"javascript:alert(1)",
		"not a url",
		"",
	];
	for (const u of bad) {
		test(`rejects ${JSON.stringify(u)}`, async () => {
			const { auth } = setup();
			assert.equal(await codeOf(Promise.resolve().then(() => auth.parsePastedUrl(u))), "bad-paste-url");
		});
	}
});

async function signedIn() {
	const s = setup();
	s.tokens.value = "RT0";
	return s;
}

describe("refresh", () => {
	test("is single-flight across concurrent callers", async () => {
		const { auth, http } = await signedIn();
		const hold = deferred<ReturnType<typeof jsonResponse>>();
		http.enqueue(() => hold.promise);
		const calls = Array.from({ length: 5 }, () => auth.getAccessToken());
		hold.resolve(jsonResponse(200, tokenBody({ access_token: "AT2", refresh_token: "RT2" })));
		assert.deepEqual(await Promise.all(calls), ["AT2", "AT2", "AT2", "AT2", "AT2"]);
		assert.equal(http.requests.length, 1);
		const form = formOf(http.requests[0]!);
		assert.equal(form.get("grant_type"), "refresh_token");
		assert.equal(form.get("refresh_token"), "RT0");
		assert.equal(form.get("client_id"), CLIENT_ID);
		assert.equal(form.get("scope"), SCOPE);
	});

	test("stores the rotated refresh token before returning the access token", async () => {
		const { auth, http, tokens } = await signedIn();
		http.enqueueJson(200, tokenBody({ access_token: "AT2", refresh_token: "RT2" }));
		const at = await auth.getAccessToken().then((t) => {
			tokens.log.push(`resolved:${t}`);
			return t;
		});
		assert.equal(at, "AT2");
		assert.deepEqual(tokens.log, ["set:RT2", "resolved:AT2"]);
	});

	test("keeps the cached token while more than 5 minutes remain, then refreshes", async () => {
		const { auth, http, clock } = await signedIn();
		http.enqueueJson(200, tokenBody({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }));
		await auth.getAccessToken();
		clock.advance(3600_000 - 5 * 60_000 - 1);
		assert.equal(await auth.getAccessToken(), "AT2");
		assert.equal(http.requests.length, 1);
		clock.advance(2);
		http.enqueueJson(200, tokenBody({ access_token: "AT3", refresh_token: "RT3" }));
		assert.equal(await auth.getAccessToken(), "AT3");
		assert.equal(formOf(http.requests[1]!).get("refresh_token"), "RT2");
	});

	test("a refresh without a new refresh token keeps the stored one", async () => {
		const { auth, http, tokens } = await signedIn();
		http.enqueueJson(200, tokenBody({ access_token: "AT2", refresh_token: undefined }));
		assert.equal(await auth.getAccessToken(), "AT2");
		assert.equal(tokens.value, "RT0");
	});

	for (const err of ["invalid_grant", "interaction_required"]) {
		test(`${err} clears the token and sets sign-in required`, async () => {
			const { auth, http, tokens, statuses } = await signedIn();
			http.enqueueJson(400, { error: err, error_description: "x" });
			assert.equal(await codeOf(auth.getAccessToken()), "sign-in-required");
			assert.equal(tokens.value, null);
			assert.equal(auth.status, "sign-in-required");
			assert.deepEqual(statuses, ["sign-in-required"]);
			// No token, no further requests.
			assert.equal(await codeOf(auth.getAccessToken()), "sign-in-required");
			assert.equal(http.requests.length, 1);
		});
	}

	test("a network error keeps the token and a later call retries", async () => {
		const { auth, http, tokens } = await signedIn();
		http.enqueueNetworkError();
		assert.equal(await codeOf(auth.getAccessToken()), "network");
		assert.equal(tokens.value, "RT0");
		http.enqueueJson(200, tokenBody({ access_token: "AT2", refresh_token: "RT2" }));
		assert.equal(await auth.getAccessToken(), "AT2");
	});

	test("a 5xx keeps the token", async () => {
		const { auth, http, tokens } = await signedIn();
		http.enqueueJson(503, { error: "temporarily_unavailable" });
		assert.equal(await codeOf(auth.getAccessToken()), "token-request-failed");
		assert.equal(tokens.value, "RT0");
		assert.equal(auth.status, "signed-in");
	});

	test("an invalid refresh response keeps the token", async () => {
		const { auth, http, tokens } = await signedIn();
		http.enqueueJson(200, tokenBody({ token_type: "MAC" }));
		assert.equal(await codeOf(auth.getAccessToken()), "invalid-response");
		assert.equal(tokens.value, "RT0");
	});

	test("with no stored token it fails without a request", async () => {
		const { auth, http } = setup();
		assert.equal(await codeOf(auth.getAccessToken()), "signed-out");
		assert.equal(http.requests.length, 0);
	});
});

describe("sign-out", () => {
	test("clears tokens and drops the cached access token", async () => {
		const { auth, http, tokens, statuses } = await signedIn();
		http.enqueueJson(200, tokenBody({ access_token: "AT2", refresh_token: "RT2" }));
		await auth.getAccessToken();
		await auth.signOut();
		assert.equal(tokens.value, null);
		assert.equal(auth.status, "signed-out");
		assert.equal(statuses[statuses.length - 1], "signed-out");
		assert.equal(await codeOf(auth.getAccessToken()), "signed-out");
	});

	test("an in-flight refresh finishing after sign-out stores nothing", async () => {
		const { auth, http, tokens } = await signedIn();
		const hold = deferred<ReturnType<typeof jsonResponse>>();
		http.enqueue(() => hold.promise);
		const pending = auth.getAccessToken();
		await auth.signOut();
		hold.resolve(jsonResponse(200, tokenBody({ access_token: "AT2", refresh_token: "RT2" })));
		assert.equal(await codeOf(pending), "signed-out");
		assert.equal(tokens.value, null);
		assert.equal(auth.status, "signed-out");
	});

	test("an in-flight code redemption finishing after sign-out stores nothing", async () => {
		const { auth, http, tokens } = setup();
		const { state } = await startSignIn(auth);
		const hold = deferred<ReturnType<typeof jsonResponse>>();
		http.enqueue(() => hold.promise);
		const pending = auth.handleCallback({ code: "C", state }, "protocol");
		await auth.signOut();
		hold.resolve(jsonResponse(200, tokenBody()));
		assert.equal(await codeOf(pending), "signed-out");
		assert.equal(tokens.value, null);
	});

	test("cancels a pending sign-in", async () => {
		const { auth } = setup();
		const { state } = await startSignIn(auth);
		await auth.signOut();
		assert.equal(await codeOf(auth.handleCallback({ code: "C", state }, "protocol")), "no-pending");
	});
});

test("initial status reflects the stored token", () => {
	const http = new FakeHttp();
	const tokens = new MemoryTokenStore();
	tokens.value = "RT";
	const auth = new AuthClient({ transport: http, tokens, clock: new FakeClock(), getClientId: () => CLIENT_ID });
	assert.equal(auth.status, "signed-in");
});

describe("security review fixes", () => {
	test("refuses to start a sign-in while already signed in", async () => {
		const { auth } = await signedIn();
		assert.equal(await codeOf(auth.buildAuthorizeUrl(REDIRECT_PROTOCOL)), "already-signed-in");
	});

	test("a redemption invalidates an older in-flight refresh", async () => {
		const { auth, http, tokens } = await signedIn();
		const hold = deferred<ReturnType<typeof jsonResponse>>();
		http.enqueue(() => hold.promise);
		const oldRefresh = auth.getAccessToken();
		http.enqueueJson(200, tokenBody({ access_token: "AT-NEW", refresh_token: "RT-NEW" }));
		await auth.redeemCode("C", "v".repeat(43), REDIRECT_PROTOCOL);
		hold.resolve(jsonResponse(200, tokenBody({ access_token: "AT-OLD", refresh_token: "RT-OLD" })));
		assert.equal(await codeOf(oldRefresh), "signed-out");
		assert.equal(tokens.value, "RT-NEW");
		assert.equal(await auth.getAccessToken(), "AT-NEW");
	});

	test("an older refresh failing with invalid_grant after a redemption doesn't clear the new token", async () => {
		const { auth, http, tokens } = await signedIn();
		const hold = deferred<ReturnType<typeof jsonResponse>>();
		http.enqueue(() => hold.promise);
		const oldRefresh = auth.getAccessToken();
		http.enqueueJson(200, tokenBody({ access_token: "AT-NEW", refresh_token: "RT-NEW" }));
		await auth.redeemCode("C", "v".repeat(43), REDIRECT_PROTOCOL);
		hold.resolve(jsonResponse(400, { error: "invalid_grant" }));
		assert.equal(await codeOf(oldRefresh), "signed-out");
		assert.equal(tokens.value, "RT-NEW");
		assert.equal(auth.status, "signed-in");
	});

	test("a short-lived access token is still cached (margin is at most half its lifetime)", async () => {
		const { auth, http, clock } = await signedIn();
		http.enqueueJson(200, tokenBody({ access_token: "AT2", refresh_token: "RT2", expires_in: 120 }));
		assert.equal(await auth.getAccessToken(), "AT2");
		clock.advance(59_000);
		assert.equal(await auth.getAccessToken(), "AT2");
		assert.equal(http.requests.length, 1);
		clock.advance(2_000);
		http.enqueueJson(200, tokenBody({ access_token: "AT3", refresh_token: "RT3" }));
		assert.equal(await auth.getAccessToken(), "AT3");
	});

	test("a failed token clear surfaces from signOut and status stays honest", async () => {
		const { auth, tokens } = await signedIn();
		tokens.clear = () => Promise.reject(new Error("keyring write failed"));
		await assert.rejects(auth.signOut());
		assert.equal(auth.status, "signed-in");
	});
});

test("invalid_grant still reports sign-in-required when the token clear fails", async () => {
	const { auth, http, tokens } = await signedIn();
	tokens.clear = () => Promise.reject(new Error("keyring write failed"));
	http.enqueueJson(400, { error: "invalid_grant" });
	assert.equal(await codeOf(auth.getAccessToken()), "sign-in-required");
	assert.equal(auth.status, "sign-in-required");
	assert.equal(await codeOf(auth.getAccessToken()), "sign-in-required");
	assert.equal(http.requests.length, 1);
});

test("a failed undo after sign-out during redemption is surfaced and status is honest", async () => {
	const { auth, http, tokens, statuses } = setup();
	const { state } = await startSignIn(auth);
	const hold = deferred<void>();
	const realSet = tokens.set.bind(tokens);
	tokens.set = async (rt) => {
		await hold.promise;
		await realSet(rt);
	};
	http.enqueueJson(200, tokenBody());
	const pending = auth.handleCallback({ code: "C", state }, "protocol");
	await new Promise((r) => setImmediate(r));
	await auth.signOut();
	tokens.clear = () => Promise.reject(new Error("keyring write failed"));
	hold.resolve();
	await assert.rejects(pending, (e: unknown) => e instanceof Error && e.message === "keyring write failed");
	assert.equal(auth.status, "signed-in");
	assert.equal(statuses[statuses.length - 1], "signed-in");
});
