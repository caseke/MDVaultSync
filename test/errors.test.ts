import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphError, ResyncRequired, isResyncCode, sanitizeGraphCode, toGraphError, MAX_ERROR_BODY } from "../src/remote/errors.ts";
import { bytes, jsonResponse } from "./fakes/fake-http.ts";
import type { HttpResponse } from "../src/core/ports.ts";

const raw = (status: number, s: string): HttpResponse => ({ status, headers: {}, body: bytes(s) });

test("maps code and inner codes, walking nested innerError", () => {
	const e = toGraphError(
		jsonResponse(412, {
			error: { code: "resourceModified", message: "/drive/secret.md", innerError: { code: "entityTagDoesNotMatch", innerError: { code: "deeper" } } },
		}),
	);
	assert.ok(e instanceof GraphError);
	assert.ok(!(e instanceof ResyncRequired));
	assert.equal(e.status, 412);
	assert.equal(e.code, "resourceModified");
	assert.deepEqual(e.innerCodes, ["entityTagDoesNotMatch", "deeper"]);
	assert.ok(!e.message.includes("secret"));
	assert.equal(e.message, "graph-412-resourceModified");
});

test("inner code walk stops at depth 8", () => {
	let inner: Record<string, unknown> = { code: "c9" };
	for (let i = 8; i >= 1; i--) inner = { code: `c${i}`, innerError: inner };
	const e = toGraphError(jsonResponse(400, { error: { code: "top", innerError: inner } }));
	assert.equal(e.innerCodes.length, 8);
});

test("innererror spelled in lower case is walked too", () => {
	const e = toGraphError(jsonResponse(400, { error: { code: "invalidRequest", innererror: { code: "invalidPath" } } }));
	assert.deepEqual(e.innerCodes, ["invalidPath"]);
});

test("any 410 is ResyncRequired, even without a body", () => {
	const e = toGraphError(raw(410, ""));
	assert.ok(e instanceof ResyncRequired);
	assert.equal(e.status, 410);
	assert.equal(e.code, "other");
});

test("resync* codes at the top or inner level are ResyncRequired", () => {
	for (const code of ["resyncRequired", "resyncApplyDifferences", "resyncChangesUploadDifferences"]) {
		assert.ok(toGraphError(jsonResponse(400, { error: { code } })) instanceof ResyncRequired, code);
	}
	assert.ok(toGraphError(jsonResponse(400, { error: { code: "invalidRequest", innerError: { code: "resyncUploadDifferences" } } })) instanceof ResyncRequired);
	assert.equal(isResyncCode("resyncRequired"), true);
	assert.equal(isResyncCode("notResync"), false);
});

test("bad, oversized or odd bodies give code 'other'", () => {
	assert.equal(toGraphError(raw(500, "<html>oops</html>")).code, "other");
	assert.equal(toGraphError(raw(500, JSON.stringify({ error: "string" }))).code, "other");
	assert.equal(toGraphError(raw(500, JSON.stringify([1]))).code, "other");
	const big = JSON.stringify({ error: { code: "tooBig" }, pad: "x".repeat(MAX_ERROR_BODY) });
	assert.equal(toGraphError(raw(500, big)).code, "other");
});

test("sanitizeGraphCode keeps identifiers and rejects anything else", () => {
	assert.equal(sanitizeGraphCode("nameAlreadyExists"), "nameAlreadyExists");
	assert.equal(sanitizeGraphCode("a.b-c_1"), "a.b-c_1");
	for (const v of ["has space", "path/x", "", "x".repeat(65), 12, null, undefined, {}]) assert.equal(sanitizeGraphCode(v), "other");
});

test("error codes with path-like text never reach the message", () => {
	const e = toGraphError(jsonResponse(400, { error: { code: "Private/Diary.md" } }));
	assert.equal(e.code, "other");
	assert.ok(!`${e.message}${e.stack ?? ""}`.includes("Diary"));
});
