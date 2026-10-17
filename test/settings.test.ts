import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_DATA,
	MAX_PATTERN_LINES,
	defaultDeviceName,
	effectiveDeviceName,
	excludePatternsInvalid,
	pauseFromData,
	snapshotForSave,
	intervalFloor,
	isValidClientId,
	parseData,
	parseDeviceName,
	parseExcludePatterns,
	parseInterval,
	parseMaxFileSize,
	parseThreshold,
	toEngineSettings,
} from "../src/settings.ts";

test("missing or non-object data gives defaults", () => {
	for (const raw of [null, undefined, 42, "x", []]) assert.deepEqual(parseData(raw), DEFAULT_DATA);
});

test("defaults follow design §11", () => {
	assert.deepEqual(DEFAULT_DATA, {
		clientId: "",
		deviceName: "",
		intervalMinutes: 5,
		maxFileSizeMiB: 100,
		excludePatterns: [],
		previewEveryRun: false,
		massDeleteThresholdPct: 25,
		verboseLogging: false,
	});
	assert.ok(Object.isFrozen(DEFAULT_DATA.excludePatterns));
});

test("keeps well-typed fields and drops mistyped or unknown ones", () => {
	assert.deepEqual(parseData({ clientId: "abc", fallbackRefreshToken: "RT", extra: 1 }), {
		...DEFAULT_DATA,
		clientId: "abc",
		fallbackRefreshToken: "RT",
	});
	assert.deepEqual(parseData({ clientId: 5, fallbackRefreshToken: "" }), DEFAULT_DATA);
});

test("keeps valid sync settings", () => {
	const d = parseData({
		deviceName: "Work laptop",
		intervalMinutes: 0,
		maxFileSizeMiB: 1024,
		excludePatterns: ["Private/", "*.tmp"],
		previewEveryRun: true,
		massDeleteThresholdPct: 100,
	});
	assert.equal(d.deviceName, "Work laptop");
	assert.equal(d.intervalMinutes, 0);
	assert.equal(d.maxFileSizeMiB, 1024);
	assert.deepEqual(d.excludePatterns, ["Private/", "*.tmp"]);
	assert.equal(d.previewEveryRun, true);
	assert.equal(d.massDeleteThresholdPct, 100);
});

test("a tampered data.json can't set out-of-range or mistyped sync settings (T-T6)", () => {
	const d = parseData({
		deviceName: "a/b",
		intervalMinutes: 1441,
		maxFileSizeMiB: 0,
		excludePatterns: ["ok", 5],
		previewEveryRun: "yes",
		massDeleteThresholdPct: 0.5,
	});
	assert.deepEqual({ ...d, clientId: "" }, DEFAULT_DATA);
	assert.equal(parseData({ intervalMinutes: Number.NaN }).intervalMinutes, 5);
	assert.equal(parseData({ maxFileSizeMiB: 2.5 }).maxFileSizeMiB, 100);
	assert.equal(parseData({ excludePatterns: Array.from({ length: MAX_PATTERN_LINES + 1 }, () => "x") }).excludePatterns.length, 0);
});

test("parseData returns fresh objects each time", () => {
	const a = parseData(null);
	a.clientId = "changed";
	a.excludePatterns.push("x");
	assert.equal(DEFAULT_DATA.clientId, "");
	assert.deepEqual(parseData(null).excludePatterns, []);
});

test("client IDs must be GUIDs", () => {
	assert.equal(isValidClientId("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), true);
	assert.equal(isValidClientId("0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D"), true);
	assert.equal(isValidClientId(""), false);
	assert.equal(isValidClientId(" 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"), false);
	assert.equal(isValidClientId("0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d"), false);
});

test("interval: 0 (off) or 1–1440 whole minutes; the floor rises to 15 on the listing fallback (R-TRIG-2)", () => {
	assert.equal(parseInterval("0"), 0);
	assert.equal(parseInterval("1"), 1);
	assert.equal(parseInterval(" 1440 "), 1440);
	for (const bad of ["", "-1", "1441", "2.5", "abc", "1e2"]) assert.equal(parseInterval(bad), null, bad);
	assert.equal(intervalFloor("items-id"), 1);
	assert.equal(intervalFloor("approot-colon"), 1);
	assert.equal(intervalFloor("children-walk"), 15);
	assert.equal(parseInterval("14", 15), null);
	assert.equal(parseInterval("15", 15), 15);
	assert.equal(parseInterval("0", 15), 0, "off is always allowed");
});

test("maximum file size: 1–1024 MiB (R-SCOPE-3)", () => {
	assert.equal(parseMaxFileSize("1"), 1);
	assert.equal(parseMaxFileSize("1024"), 1024);
	for (const bad of ["0", "1025", "", "10.5", "x"]) assert.equal(parseMaxFileSize(bad), null, bad);
});

test("mass-delete threshold: 1–100 % (R-GUARD-1)", () => {
	assert.equal(parseThreshold("1"), 1);
	assert.equal(parseThreshold("100"), 100);
	for (const bad of ["0", "101", "", "25%", "x"]) assert.equal(parseThreshold(bad), null, bad);
});

test("exclude patterns: one per line, at most 200 lines, trailing blank lines dropped", () => {
	assert.deepEqual(parseExcludePatterns("Private/\r\n*.tmp\n\n"), ["Private/", "*.tmp"]);
	assert.deepEqual(parseExcludePatterns(""), []);
	assert.deepEqual(parseExcludePatterns("# comment\n\nDrafts/"), ["# comment", "", "Drafts/"]);
	assert.equal(parseExcludePatterns(Array.from({ length: MAX_PATTERN_LINES }, () => "x").join("\n"))?.length, MAX_PATTERN_LINES);
	assert.equal(parseExcludePatterns(Array.from({ length: MAX_PATTERN_LINES + 1 }, () => "x").join("\n")), null);
	assert.equal(parseExcludePatterns("x".repeat(1001)), null, "a single huge line is refused");
});

test("device name: 1–40 characters that are a valid file name (it goes into conflict copy names)", () => {
	assert.equal(parseDeviceName("  iPad  "), "iPad");
	assert.equal(parseDeviceName("x".repeat(40)), "x".repeat(40));
	for (const bad of ["", "   ", "x".repeat(41), "a/b", "a:b", "CON", "~home", "tab\there"]) assert.equal(parseDeviceName(bad), null, bad);
});

test("the default device name comes from the platform; an empty setting means the default", () => {
	assert.equal(defaultDeviceName("ios"), "iPad");
	assert.equal(defaultDeviceName("linux"), "Ubuntu");
	assert.equal(defaultDeviceName("other"), "Device");
	assert.equal(effectiveDeviceName({ ...DEFAULT_DATA, excludePatterns: [] }, "iPad"), "iPad");
	assert.equal(effectiveDeviceName({ ...DEFAULT_DATA, excludePatterns: [], deviceName: "Desk" }, "iPad"), "Desk");
});

test("toEngineSettings converts MiB to bytes and copies the rest", () => {
	const d = parseData({ maxFileSizeMiB: 3, excludePatterns: ["a"], previewEveryRun: true, massDeleteThresholdPct: 40 });
	const s = toEngineSettings(d, "Ubuntu");
	assert.deepEqual(s, {
		excludePatterns: ["a"],
		maxFileSize: 3 * 1024 * 1024,
		deviceName: "Ubuntu",
		previewEveryRun: true,
		massDeleteThresholdPct: 40,
	});
	assert.notEqual(s.excludePatterns, d.excludePatterns, "a copy: a later settings change doesn't change a running sync's view");
});

test("exclude patterns fail closed: a present but invalid list is flagged, never silently empty (T-I6, M7 review)", () => {
	assert.equal(excludePatternsInvalid(null), false);
	assert.equal(excludePatternsInvalid({}), false, "absent: the default (none)");
	assert.equal(excludePatternsInvalid({ excludePatterns: ["Private/"] }), false);
	assert.equal(excludePatternsInvalid({ excludePatterns: ["Private/", 1] }), true);
	assert.equal(excludePatternsInvalid({ excludePatterns: "Private/" }), true);
	assert.equal(excludePatternsInvalid({ excludePatterns: Array.from({ length: MAX_PATTERN_LINES + 1 }, () => "x") }), true);
	assert.equal(excludePatternsInvalid({ excludePatterns: ["x".repeat(1001)] }), true);
});

test("while paused for bad patterns, every other save writes the unreadable value back, so a restart stays paused", () => {
	const raw = { clientId: "", excludePatterns: ["Private/", 1] };
	const data = parseData(raw);
	const snap = snapshotForSave(data, { intervalMinutes: 10 }, raw.excludePatterns);
	assert.equal(snap.intervalMinutes, 10);
	assert.equal(excludePatternsInvalid(snap), true, "reloading the written data.json still pauses");
	const resumed = snapshotForSave(data, { excludePatterns: ["Private/"] }, raw.excludePatterns);
	assert.equal(excludePatternsInvalid(resumed), false, "saving patterns resumes");
	assert.deepEqual(snapshotForSave(data, { previewEveryRun: true }, undefined).excludePatterns, [], "not paused: the parsed value");
});

test("a data.json on disk that doesn't parse to an object pauses sync too: its patterns are unknown (third review)", () => {
	assert.deepEqual(pauseFromData(null, false), { paused: false }, "no file: a fresh install");
	assert.deepEqual(pauseFromData({}, true), { paused: false });
	assert.deepEqual(pauseFromData({ excludePatterns: ["a"] }, true), { paused: false });
	for (const raw of [null, "x", 5, []]) {
		const p = pauseFromData(raw, true);
		assert.equal(p.paused, true, JSON.stringify(raw));
		assert.ok(p.paused && p.raw === null && excludePatternsInvalid({ excludePatterns: p.raw }), "the marker written back still reads as invalid");
	}
	const bad = pauseFromData({ excludePatterns: ["Private/", 1, "x".repeat(1001), "*.tmp"] }, true);
	assert.ok(bad.paused);
	assert.deepEqual(bad.readable, ["Private/", "*.tmp"], "readable lines pre-fill the field");
	const garbled = pauseFromData(null, true);
	assert.ok(garbled.paused);
	assert.deepEqual(garbled.readable, []);
});

test("verboseLogging: off by default; only a boolean is accepted (design §9, M8 matrix row 10)", () => {
	assert.equal(parseData({}).verboseLogging, false);
	assert.equal(parseData({ verboseLogging: true }).verboseLogging, true);
	assert.equal(parseData({ verboseLogging: "yes" }).verboseLogging, false);
});
