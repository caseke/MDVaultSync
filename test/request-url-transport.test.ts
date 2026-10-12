import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NetworkError,
	createRequestUrlTransport,
	type RequestUrlFn,
	type RequestUrlParamLike,
} from "../src/platform/request-url-transport.ts";
import { bytes } from "./fakes/fake-http.ts";

function fake(respond: (p: RequestUrlParamLike) => { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }) {
	const seen: RequestUrlParamLike[] = [];
	const fn: RequestUrlFn = (p) => {
		seen.push(p);
		return Promise.resolve(respond(p));
	};
	return { fn, seen };
}

test("sends throw:false and returns lower-cased headers with an ArrayBuffer body", async () => {
	const { fn, seen } = fake(() => ({ status: 404, headers: { "Content-Type": "application/json", ETag: "x" }, arrayBuffer: bytes("{}") }));
	const t = createRequestUrlTransport(fn);
	const res = await t.send({ url: "https://graph.microsoft.com/v1.0/me", method: "GET", headers: { Accept: "application/json" } });
	assert.equal(seen[0]?.throw, false);
	assert.equal(seen[0]?.method, "GET");
	assert.deepEqual(seen[0]?.headers, { Accept: "application/json" });
	assert.equal(res.status, 404);
	assert.deepEqual(res.headers, { "content-type": "application/json", etag: "x" });
	assert.ok(res.body instanceof ArrayBuffer);
	assert.equal(res.body.byteLength, 2);
});

test("moves Content-Type into contentType and passes the body through", async () => {
	const { fn, seen } = fake(() => ({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) }));
	const t = createRequestUrlTransport(fn);
	await t.send({
		url: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", "X-Other": "1" },
		body: "a=b",
	});
	assert.equal(seen[0]?.contentType, "application/x-www-form-urlencoded");
	assert.deepEqual(seen[0]?.headers, { "X-Other": "1" });
	assert.equal(seen[0]?.body, "a=b");
});

test("a thrown request becomes a NetworkError that carries no URL or message", async () => {
	const fn: RequestUrlFn = () => Promise.reject(new Error("net::ERR at https://graph.microsoft.com/secret-path?code=XYZ"));
	const t = createRequestUrlTransport(fn);
	const e = await t.send({ url: "https://graph.microsoft.com/secret-path?code=XYZ", method: "GET" }).catch((x: unknown) => x);
	assert.ok(e instanceof NetworkError);
	const dump = `${String(e)} ${JSON.stringify(e)} ${e.stack ?? ""}`;
	assert.ok(!dump.includes("secret-path"));
	assert.ok(!dump.includes("XYZ"));
});
