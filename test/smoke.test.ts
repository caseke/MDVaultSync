import { test } from "node:test";
import assert from "node:assert/strict";
import * as ports from "../src/core/ports.ts";
import type { Clock, HttpRequest, HttpResponse, HttpTransport } from "../src/core/ports.ts";

test("the test runner executes TypeScript through Node type stripping", () => {
	assert.equal(1 + 1, 2);
});

test("ports.ts loads under type stripping and exports no runtime values", () => {
	// ports.ts holds only erasable types (design §2), so the stripped module is empty.
	assert.deepEqual(Object.keys(ports), []);
});

test("port interfaces can be implemented by plain objects", async () => {
	const clock: Clock = { now: () => 42, sleep: () => Promise.resolve() };
	const transport: HttpTransport = {
		send: (req: HttpRequest): Promise<HttpResponse> =>
			Promise.resolve({ status: 204, headers: { "x-method": req.method }, body: new ArrayBuffer(0) }),
	};
	const res = await transport.send({ url: "https://graph.microsoft.com/v1.0/me", method: "GET" });
	assert.equal(res.status, 204);
	assert.equal(res.headers["x-method"], "GET");
	assert.equal(clock.now(), 42);
});
