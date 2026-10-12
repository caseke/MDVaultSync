import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthorizingTransport } from "../src/remote/http.ts";
import { FakeHttp } from "./fakes/fake-http.ts";

function setup() {
	const inner = new FakeHttp();
	let calls = 0;
	const tokens = {
		getAccessToken: () => {
			calls++;
			return Promise.resolve("AT-SENTINEL");
		},
	};
	const t = new AuthorizingTransport(inner, tokens);
	const ok = () => ({ status: 200, headers: {}, body: new ArrayBuffer(0) });
	return { inner, t, ok, calls: () => calls };
}

test("adds a bearer token for graph.microsoft.com over https", async () => {
	const { inner, t, ok } = setup();
	inner.enqueue(ok);
	await t.send({ url: "https://graph.microsoft.com/v1.0/me/drive", method: "GET", headers: { Accept: "application/json" } });
	assert.equal(inner.requests[0]?.headers?.["Authorization"], "Bearer AT-SENTINEL");
	assert.equal(inner.requests[0]?.headers?.["Accept"], "application/json");
});

const nonGraph = [
	"https://graph.microsoft.com.evil.com/v1.0/me",
	"http://graph.microsoft.com/v1.0/me",
	"https://evil.com/?graph.microsoft.com",
	"https://evil.com/https://graph.microsoft.com/",
	"https://graph.microsoft.co/v1.0/me",
	"https://api.onedrive.com/up/abc",
	"https://my.microsoftpersonalcontent.com/x",
	"https://public.am.files.1drv.com/y",
	"https://tenant.sharepoint.com/_api/v2.0/drive/items/1/uploadSession",
	"https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
];

for (const url of nonGraph) {
	test(`never sends Authorization to ${url}`, async () => {
		const { inner, t, ok, calls } = setup();
		inner.enqueue(ok);
		await t.send({
			url,
			method: "PUT",
			headers: { Authorization: "Bearer leaked", authorization: "Bearer leaked2", "Content-Range": "bytes 0-1/2" },
		});
		const sent = inner.requests[0]?.headers ?? {};
		for (const k of Object.keys(sent)) assert.notEqual(k.toLowerCase(), "authorization");
		assert.equal(sent["Content-Range"], "bytes 0-1/2");
		assert.equal(calls(), 0, "token provider must not be asked for non-Graph URLs");
	});
}

test("an unparseable URL is rejected without a token", async () => {
	const { t, calls } = setup();
	await assert.rejects(t.send({ url: "not a url", method: "GET" }));
	assert.equal(calls(), 0);
});

test("a caller-supplied Authorization on a Graph URL is replaced, not duplicated", async () => {
	const { inner, t, ok } = setup();
	inner.enqueue(ok);
	await t.send({ url: "https://graph.microsoft.com/v1.0/me", method: "GET", headers: { authorization: "Bearer other" } });
	const sent = inner.requests[0]?.headers ?? {};
	const auth = Object.entries(sent).filter(([k]) => k.toLowerCase() === "authorization");
	assert.deepEqual(auth, [["Authorization", "Bearer AT-SENTINEL"]]);
});
