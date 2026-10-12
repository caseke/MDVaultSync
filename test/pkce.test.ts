import { test } from "node:test";
import assert from "node:assert/strict";
import { challengeFromVerifier, createState, createVerifier, timingSafeEqual } from "../src/remote/pkce.ts";

test("challenge matches the RFC 7636 Appendix B vector", async () => {
	assert.equal(
		await challengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
		"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
	);
});

test("verifier is 43–128 characters from the RFC 7636 alphabet", () => {
	const seen = new Set<string>();
	for (let i = 0; i < 1000; i++) {
		const v = createVerifier();
		assert.ok(v.length >= 43 && v.length <= 128, `length ${v.length}`);
		assert.match(v, /^[A-Za-z0-9\-._~]+$/);
		seen.add(v);
	}
	assert.equal(seen.size, 1000, "verifiers repeat");
});

test("verifier draws from the whole alphabet", () => {
	const chars = new Set<string>();
	for (let i = 0; i < 200; i++) for (const c of createVerifier()) chars.add(c);
	assert.equal(chars.size, 66);
});

test("state is 32 random bytes in base64url", () => {
	const a = createState();
	const b = createState();
	assert.match(a, /^[A-Za-z0-9_-]{43}$/);
	assert.notEqual(a, b);
});

test("timingSafeEqual compares whole strings", () => {
	assert.equal(timingSafeEqual("abc", "abc"), true);
	assert.equal(timingSafeEqual("abc", "abd"), false);
	assert.equal(timingSafeEqual("abc", "abcd"), false);
	assert.equal(timingSafeEqual("", ""), true);
	assert.equal(timingSafeEqual("", "a"), false);
});
