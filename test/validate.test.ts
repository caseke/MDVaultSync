import { test } from "node:test";
import assert from "node:assert/strict";
import {
	InvalidResponse,
	MAX_JSON_BODY,
	TRANSFER_HOST_SUFFIXES,
	checkName,
	checkTransferUrl,
	isGraphApiUrl,
	parseChildrenPage,
	parseDeltaPage,
	parseDriveItem,
	parseItemExtras,
	parseQuota,
	parseUploadSession,
	parseUploadStatus,
} from "../src/remote/validate.ts";
import { UntrustedUrl } from "../src/remote/errors.ts";
import { bytes } from "./fakes/fake-http.ts";

const HASH = "AAAAAAAAAAAAAAAAAAAAAAAAAAA=";
function file(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "ABC123!101",
		name: "note.md",
		eTag: '"{ABC},2"',
		cTag: '"c:{ABC},1"',
		size: 42,
		lastModifiedDateTime: "2026-10-12T00:00:00Z",
		parentReference: { id: "PARENT!1", driveId: "d" },
		file: { mimeType: "text/markdown", hashes: { quickXorHash: HASH, sha256Hash: "ignored" } },
		...over,
	};
}
const body = (o: unknown) => bytes(JSON.stringify(o));

test("parses a file item into a RemoteItem, ignoring unknown fields", () => {
	assert.deepEqual(parseDriveItem({ ...file(), extra: { deep: [1] } }), {
		id: "ABC123!101",
		parentId: "PARENT!1",
		name: "note.md",
		isFolder: false,
		eTag: '"{ABC},2"',
		cTag: '"c:{ABC},1"',
		size: 42,
		quickXorHash: HASH,
		lastModified: "2026-10-12T00:00:00Z",
		deleted: false,
	});
});

test("folders, items with no parent, missing hash and missing cTag", () => {
	const f = parseDriveItem({ id: "F1", name: "Folder", eTag: "e", size: 0, folder: { childCount: 0 } });
	assert.equal(f.isFolder, true);
	assert.equal(f.parentId, null);
	assert.equal(f.cTag, null);
	assert.equal(f.quickXorHash, null);
	assert.equal(f.lastModified, "");
	assert.equal(parseDriveItem(file({ file: { mimeType: "x" } })).quickXorHash, null);
});

test("deleted items may omit size, cTag, eTag and name [G-DL-5]", () => {
	const d = parseDriveItem({ id: "GONE1", deleted: { state: "deleted" }, parentReference: { id: "P" } });
	assert.equal(d.deleted, true);
	assert.equal(d.size, 0);
	assert.equal(d.eTag, "");
	assert.equal(d.name, "");
});

const hostileNames = ["..", ".", "a/b", "a\\b", "a\u0000b", "", "x".repeat(256), 7, null];
for (const name of hostileNames) {
	test(`rejects item name ${JSON.stringify(name)?.slice(0, 20)}`, () => {
		assert.throws(() => parseDriveItem(file({ name })), InvalidResponse);
	});
}

test("accepts 255-character names, hidden names, unicode and emoji", () => {
	for (const name of ["x".repeat(255), ".mdvaultsync-probe", "café.md", "📝 note.md", "100% #1?.md"]) {
		assert.equal(parseDriveItem(file({ name })).name, name);
	}
});

const hostileIds = ["", "a/b", "a b", "../x", "x".repeat(257), "a%2Fb", "a:b", 5, null, undefined];
for (const id of hostileIds) {
	test(`rejects item id ${JSON.stringify(id)?.slice(0, 20)}`, () => {
		assert.throws(() => parseDriveItem(file({ id })), InvalidResponse);
	});
}

test("rejects a hostile parent id", () => {
	assert.throws(() => parseDriveItem(file({ parentReference: { id: "../../x" } })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ parentReference: "P" })), InvalidResponse);
});

for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, "42", null, Infinity]) {
	test(`rejects size ${String(size)}`, () => {
		assert.throws(() => parseDriveItem(file({ size })), InvalidResponse);
	});
}

test("rejects missing size on a live item", () => {
	const f = file();
	delete f["size"];
	assert.throws(() => parseDriveItem(f), InvalidResponse);
});

test("rejects oversized or mistyped tags and timestamps", () => {
	assert.throws(() => parseDriveItem(file({ eTag: "e".repeat(513) })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ eTag: "" })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ eTag: 1 })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ cTag: "c".repeat(513) })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ cTag: 5 })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ lastModifiedDateTime: "t".repeat(65) })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ lastModifiedDateTime: 5 })), InvalidResponse);
	assert.equal(parseDriveItem(file({ eTag: "e".repeat(512) })).eTag.length, 512);
});

for (const h of ["", "AAAA", `${HASH}A`, "!!!!!!!!!!!!!!!!!!!!!!!!!!!=", 7]) {
	test(`rejects quickXorHash ${JSON.stringify(h)}`, () => {
		assert.throws(() => parseDriveItem(file({ file: { hashes: { quickXorHash: h } } })), InvalidResponse);
	});
}

test("rejects non-object items and facets", () => {
	for (const v of [null, 1, "x", [file()]]) assert.throws(() => parseDriveItem(v), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ file: "x" })), InvalidResponse);
	assert.throws(() => parseDriveItem(file({ file: { hashes: "x" } })), InvalidResponse);
});

test("parseItemExtras: download URL must be on an allowlisted host; parent path is optional", () => {
	const ok = parseItemExtras(file({ "@microsoft.graph.downloadUrl": "https://public.dm.files.1drv.com/x?t=1", parentReference: { id: "P", path: "/drive/root:/Apps" } }));
	assert.equal(ok.downloadUrl, "https://public.dm.files.1drv.com/x?t=1");
	assert.equal(ok.parentPath, "/drive/root:/Apps");
	assert.deepEqual(parseItemExtras(file()), { downloadUrl: null, parentPath: null });
	assert.throws(() => parseItemExtras(file({ "@microsoft.graph.downloadUrl": "https://evil.example/x" })), UntrustedUrl);
	assert.throws(() => parseItemExtras(file({ parentReference: { id: "P", path: 5 } })), InvalidResponse);
	assert.throws(() => parseItemExtras(file({ parentReference: { id: "P", path: "p".repeat(2049) } })), InvalidResponse);
});

test("transfer URL allowlist (design §8, T-T5)", () => {
	assert.deepEqual([...TRANSFER_HOST_SUFFIXES], [".microsoft.com", ".live.com", ".sharepoint.com", ".1drv.com", ".onedrive.com", ".livefilestore.com"]);
	for (const u of [
		"https://api.onedrive.com/up/1",
		"https://public.dm.files.1drv.com/y",
		"https://x.livefilestore.com/z",
		"https://t.sharepoint.com/a",
		"https://my.microsoft.com/a",
		"https://b.live.com/c",
	]) assert.equal(checkTransferUrl(u), u);
	for (const u of [
		"http://api.onedrive.com/up/1",
		"https://onedrive.com.evil.net/x",
		"https://evilonedrive.com/x",
		"https://microsoft.com.evil.net/x",
		"https://user:pw@api.onedrive.com/x",
		"https://api.onedrive.com:8443/x",
		"https://1drv.com/x",
		"not a url",
		"",
		"javascript:alert(1)",
		"https://api.onedrive.com./x",
		7,
		null,
	]) assert.throws(() => checkTransferUrl(u), UntrustedUrl, String(u));
});

test("an UntrustedUrl error carries no URL", () => {
	const e = (() => {
		try {
			checkTransferUrl("https://evil.example/TEMPAUTH-SECRET");
		} catch (x) {
			return x as Error;
		}
		return null;
	})();
	assert.ok(e && !`${e.message}${e.stack ?? ""}`.includes("TEMPAUTH"));
});

test("isGraphApiUrl accepts only https://graph.microsoft.com/v1.0/ URLs", () => {
	assert.equal(isGraphApiUrl("https://graph.microsoft.com/v1.0/me/drive/items/X/delta?token=1"), true);
	for (const u of ["https://graph.microsoft.com/beta/x", "https://graph.microsoft.com.evil/v1.0/x", "http://graph.microsoft.com/v1.0/x", "https://api.onedrive.com/v1.0/x", "nope", 3]) {
		assert.equal(isGraphApiUrl(u), false, String(u));
	}
});

test("delta page: items plus exactly one Graph link", () => {
	const next = parseDeltaPage(body({ value: [file()], "@odata.nextLink": "https://graph.microsoft.com/v1.0/d?page=2" }));
	assert.equal(next.items.length, 1);
	assert.equal(next.nextLink, "https://graph.microsoft.com/v1.0/d?page=2");
	assert.equal("deltaLink" in next, false);
	const last = parseDeltaPage(body({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/d?token=T" }));
	assert.equal(last.deltaLink, "https://graph.microsoft.com/v1.0/d?token=T");
	assert.equal("nextLink" in last, false);
});

test("delta page: rejects both, neither, foreign links, bad value and bad items", () => {
	const g = "https://graph.microsoft.com/v1.0/d";
	for (const o of [
		{ value: [] },
		{ value: [], "@odata.nextLink": g, "@odata.deltaLink": g },
		{ value: [], "@odata.nextLink": "https://evil.example/v1.0/d" },
		{ value: [], "@odata.deltaLink": 5 },
		{ "@odata.deltaLink": g },
		{ value: {}, "@odata.deltaLink": g },
		{ value: [file({ name: ".." })], "@odata.deltaLink": g },
	]) assert.throws(() => parseDeltaPage(body(o)), (e: unknown) => e instanceof InvalidResponse || e instanceof UntrustedUrl, JSON.stringify(o));
});

test("JSON bodies over 32 MiB are rejected before parsing", () => {
	assert.equal(MAX_JSON_BODY, 32 * 1024 * 1024);
	const big = new ArrayBuffer(MAX_JSON_BODY + 1);
	assert.throws(() => parseDeltaPage(big), InvalidResponse);
	assert.throws(() => parseChildrenPage(big), InvalidResponse);
});

test("non-JSON, non-object and invalid UTF-8 bodies are rejected", () => {
	for (const b of [bytes("not json"), bytes("[1,2]"), bytes("null"), new Uint8Array([0xff, 0xfe]).buffer]) {
		assert.throws(() => parseDeltaPage(b), InvalidResponse);
	}
});

test("children page: optional nextLink", () => {
	assert.deepEqual(parseChildrenPage(body({ value: [] })), { items: [] });
	const p = parseChildrenPage(body({ value: [file()], "@odata.nextLink": "https://graph.microsoft.com/v1.0/c?page=1" }));
	assert.equal(p.nextLink, "https://graph.microsoft.com/v1.0/c?page=1");
	assert.throws(() => parseChildrenPage(body({ value: [], "@odata.nextLink": "https://evil.example/" })), UntrustedUrl);
});

test("upload session: allowlisted uploadUrl and an expiry string", () => {
	assert.deepEqual(parseUploadSession(body({ uploadUrl: "https://api.onedrive.com/up/1", expirationDateTime: "2026-10-13T00:00:00Z" })), {
		uploadUrl: "https://api.onedrive.com/up/1",
		expiresAt: "2026-10-13T00:00:00Z",
	});
	assert.throws(() => parseUploadSession(body({ uploadUrl: "https://evil.example/up", expirationDateTime: "x" })), UntrustedUrl);
	assert.throws(() => parseUploadSession(body({ uploadUrl: "https://api.onedrive.com/up/1" })), InvalidResponse);
	assert.throws(() => parseUploadSession(body({ uploadUrl: "https://api.onedrive.com/up/1", expirationDateTime: "x".repeat(65) })), InvalidResponse);
});

test("upload status: first expected range start", () => {
	assert.deepEqual(parseUploadStatus(body({ nextExpectedRanges: ["12345-"], expirationDateTime: "e" })), { nextExpectedStart: 12345, expiresAt: "e" });
	assert.deepEqual(parseUploadStatus(body({ nextExpectedRanges: ["10-20", "30-"], expirationDateTime: "e" })), { nextExpectedStart: 10, expiresAt: "e" });
	assert.deepEqual(parseUploadStatus(body({ nextExpectedRanges: [], expirationDateTime: "e" })), { nextExpectedStart: null, expiresAt: "e" });
	assert.deepEqual(parseUploadStatus(body({ expirationDateTime: "e" })), { nextExpectedStart: null, expiresAt: "e" });
	for (const r of [["abc"], ["-5"], [5], "0-", ["99999999999999999999-"]]) {
		assert.throws(() => parseUploadStatus(body({ nextExpectedRanges: r, expirationDateTime: "e" })), InvalidResponse, JSON.stringify(r));
	}
});

test("quota: non-negative integers, or null when absent", () => {
	assert.deepEqual(parseQuota(body({ quota: { total: 10, used: 4, remaining: 6, deleted: 1 } })), { total: 10, used: 4, remaining: 6 });
	assert.equal(parseQuota(body({ id: "d" })), null);
	assert.throws(() => parseQuota(body({ quota: { total: -1, used: 0, remaining: 0 } })), InvalidResponse);
	assert.throws(() => parseQuota(body({ quota: { total: "1", used: 0, remaining: 0 } })), InvalidResponse);
	assert.throws(() => parseQuota(body({ quota: 5 })), InvalidResponse);
});

test("checkName: the same name rules for names we send", () => {
	for (const n of ["a.md", "x".repeat(255), ".hidden", "café"]) assert.equal(checkName(n), n);
	for (const n of ["", ".", "..", "a/b", "a\\b", "a\u0000", "x".repeat(256)]) assert.throws(() => checkName(n), RangeError);
	assert.equal(checkName("x".repeat(300), 1024).length, 300);
});
