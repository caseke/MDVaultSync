// Sentinel test (R-SEC-3, T-I3; plan M8): a full fake sync over the production stack, with sentinel strings in
// folder names, file names, file contents, the access token, the refresh token, transfer URLs and server error
// messages. Neither the serialized log ring buffer nor any console.* call may contain one of them.
//
// The stack is wired as src/main.ts wires it: Engine → TransformedRemoteContent → GraphClient → RetryPolicy →
// AuthorizingTransport (AuthClient) → TimeoutTransport → the network, here FakeGraph plus a token endpoint. The
// logger mirrors every event to console.debug ("Verbose logging" on), and the M7 hooks (onStatus, onReport) are
// attached and fed through the status and notice code, as main.ts does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Engine, DEFAULT_ENGINE_SETTINGS } from "../src/core/engine.ts";
import { RingLogger } from "../src/core/logger.ts";
import type { HttpRequest, HttpResponse, HttpTransport, SyncReport, TokenStore } from "../src/core/ports.ts";
import { TransformedRemoteContent } from "../src/core/remote-content.ts";
import { IdentityTransform } from "../src/core/transform.ts";
import { AuthClient, TOKEN_URL } from "../src/remote/auth.ts";
import { classifyError } from "../src/remote/classify.ts";
import { NetworkError } from "../src/remote/errors.ts";
import { GraphClient } from "../src/remote/graph.ts";
import { AuthorizingTransport } from "../src/remote/http.ts";
import { RetryPolicy } from "../src/remote/retry.ts";
import { TimeoutTransport, type SetTimer } from "../src/remote/timeout.ts";
import { noticesFor } from "../src/ui/notices.ts";
import { statusText } from "../src/ui/status.ts";
import { UNIT } from "./fakes/device.ts";
import { FakeGraph, UPLOAD_HOST, URL_SECRET } from "./fakes/fake-graph.ts";
import { FakeClock, jsonResponse } from "./fakes/fake-http.ts";
import { FakeVault } from "./fakes/fake-vault.ts";
import { CFG } from "./fakes/plan-fixtures.ts";
import { ManualClock, MemoryStateStore } from "./fakes/sync-fakes.ts";

const NAME = "Zq7SentinelName";
const DIR = "Zq7SentinelDir";
const CONTENT = "Zq7SentinelContent";
const ACCESS = "Zq7SentinelAccessToken";
const REFRESH = "Zq7SentinelRefreshToken";
const SERVER_MSG = "Zq7SentinelServerMessage";
const SENTINELS = [NAME, DIR, CONTENT, ACCESS, REFRESH, SERVER_MSG, URL_SECRET, "secret/path"];
const CLIENT_ID = "00000000-0000-4000-8000-000000000001";

class MemoryTokens implements TokenStore {
	readonly backend = "secret-storage" as const;
	value: string | null;
	constructor(v: string | null) {
		this.value = v;
	}
	get(): string | null {
		return this.value;
	}
	set(rt: string): Promise<void> {
		this.value = rt;
		return Promise.resolve();
	}
	clear(): Promise<void> {
		this.value = null;
		return Promise.resolve();
	}
}

/** The network: FakeGraph for Graph and transfers, plus the token endpoint. Faults are switched by the test. */
class Network implements HttpTransport {
	readonly graph = new FakeGraph({ quotaReadable: true, realHashes: true });
	refreshes = 0;
	/** Token endpoint answers invalid_grant (a revoked app). */
	revoked = false;
	/** Every request hangs (and the timer fires at once). */
	hang = false;
	/** The next n requests fail below HTTP. */
	dropNext = 0;
	send(req: HttpRequest): Promise<HttpResponse> {
		if (this.hang) return new Promise<HttpResponse>(() => {});
		if (this.dropNext > 0) {
			this.dropNext--;
			return Promise.reject(new NetworkError());
		}
		if (req.url === TOKEN_URL) {
			const form = new URLSearchParams(typeof req.body === "string" ? req.body : "");
			assert.ok(form.get("refresh_token")?.startsWith(REFRESH));
			if (this.revoked) {
				return Promise.resolve(jsonResponse(400, { error: "invalid_grant", error_description: `${SERVER_MSG} ${NAME}`, error_codes: [70000] }));
			}
			this.refreshes++;
			return Promise.resolve(
				jsonResponse(200, { token_type: "Bearer", expires_in: 3600, access_token: `${ACCESS}-${this.refreshes}`, refresh_token: `${REFRESH}-${this.refreshes}` }),
			);
		}
		return this.graph.send(req);
	}
}

interface Dev {
	engine: Engine;
	vault: FakeVault;
	auth: AuthClient;
	reports: SyncReport[];
	shown: string[];
}

function device(net: Network, logger: RingLogger, name: string, setTimer: SetTimer): Dev {
	const vault = new FakeVault({ configDir: CFG });
	const store = new MemoryStateStore(CFG);
	const clock = new ManualClock();
	const httpClock = new FakeClock();
	const transport = new TimeoutTransport(net, setTimer);
	const auth = new AuthClient({ transport, tokens: new MemoryTokens(`${REFRESH}-0`), clock: httpClock, getClientId: () => CLIENT_ID });
	const retry = new RetryPolicy({ clock: httpClock, random: () => 0.5, logger });
	const graph = new GraphClient({ transport: new AuthorizingTransport(transport, auth), transferTransport: transport, retry, clock: httpClock, logger });
	const transform = new IdentityTransform();
	const reports: SyncReport[] = [];
	const shown: string[] = [];
	const engine = new Engine({
		remote: graph,
		content: new TransformedRemoteContent(graph, transform, { putHonorsIfMatch: true, classify: classifyError, simpleMax: UNIT, fragmentSize: UNIT }),
		vault,
		store,
		hooks: {
			confirmPlan: () => Promise.resolve(true),
			confirmDeletes: () => Promise.resolve(true),
			onStatus: (s) => shown.push(statusText(s, { now: clock.now(), lastSyncAt: null, signedIn: auth.status === "signed-in" })),
			onReport: (r) => {
				// What main.ts does with a report: notices for the user (paths allowed there, never in logs).
				noticesFor(r, reports[reports.length - 1] ?? null);
				reports.push(r);
			},
		},
		clock,
		classify: classifyError,
		configDir: CFG,
		transformId: transform.id,
		ensureSignedIn: async () => {
			await auth.getAccessToken();
		},
		resetBudget: () => retry.resetBudget(),
		settings: () => ({ ...DEFAULT_ENGINE_SETTINGS, deviceName: name }),
		newDeviceId: () => `device-${name}`,
		logger,
	});
	return { engine, vault, auth, reports, shown };
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const;

test("no sentinel name, content or token reaches the log ring buffer or the console (R-SEC-3, T-I3)", async () => {
	const captured: string[] = [];
	const saved = new Map<string, unknown>();
	const con = console as unknown as Record<string, unknown>;
	for (const m of CONSOLE_METHODS) {
		saved.set(m, con[m]);
		con[m] = (...args: unknown[]) => captured.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 }))).join(" "));
	}
	const net = new Network();
	const logger = new RingLogger({ now: () => 0, capacity: 100_000, debug: () => true });
	let hangTimers = false;
	const setTimer: SetTimer = (_ms, fn) => {
		if (hangTimers) setImmediate(fn);
		return () => {};
	};
	try {
		const a = device(net, logger, `iPad ${NAME}`, setTimer);
		const b = device(net, logger, "Ubuntu", setTimer);
		const note = `${DIR}/${NAME} note.md`;
		const big = `${DIR}/${NAME} big.bin`;
		a.vault.write(note, `${CONTENT} one`);
		a.vault.write(`${NAME}.md`, `${CONTENT} two`);
		a.vault.write(`${DIR}/sub ${NAME}/deep ${NAME}.md`, `${CONTENT} three`);
		const bigBytes = new Uint8Array(2 * UNIT + 100);
		for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = CONTENT.charCodeAt(i % CONTENT.length);
		a.vault.write(big, bigBytes);

		// 1. First sync: a refresh with the sentinel refresh token, simple uploads and an upload session.
		assert.equal((await a.engine.requestSync("startup")).result, "ok");
		assert.ok(net.graph.requests.some((r) => new URL(r.url).origin === UPLOAD_HOST), "an upload session ran");
		// 2. A second device joins and downloads everything.
		assert.equal((await b.engine.requestSync("startup")).result, "ok");
		assert.equal(b.vault.contentAt(note), `${CONTENT} one`);

		// 3. Both edit the same note: a conflict copy named after the device (and the sentinel).
		a.vault.write(note, `${CONTENT} edit A`);
		b.vault.write(note, `${CONTENT} edit B`);
		assert.equal((await b.engine.requestSync("command")).result, "ok");
		const conflict = await a.engine.requestSync("command");
		assert.equal(conflict.conflicts.length, 1);

		// 4. Rename and delete, then the other device follows.
		a.vault.rename(`${NAME}.md`, `${DIR}/${NAME} renamed.md`);
		a.vault.remove(`${DIR}/sub ${NAME}/deep ${NAME}.md`);
		assert.equal((await a.engine.requestSync("command")).result, "ok");
		assert.equal((await b.engine.requestSync("command")).result, "ok");
		assert.equal(b.vault.contentAt(`${DIR}/${NAME} renamed.md`), `${CONTENT} two`);

		// 5. A 401 mid-run: the access token is refreshed once and the request retried.
		let sent401 = false;
		net.graph.intercept = (req) => {
			if (sent401 || new URL(req.url).origin !== "https://graph.microsoft.com") return null;
			sent401 = true;
			return jsonResponse(401, { error: { code: "InvalidAuthenticationToken", message: `${SERVER_MSG} ${ACCESS}` } });
		};
		a.vault.write(`${NAME} after 401.md`, CONTENT);
		assert.equal((await a.engine.requestSync("command")).result, "ok");
		assert.ok(sent401);

		// 6. A full drive (507) with a server message that quotes the name: the run fails as quota.
		net.graph.intercept = (req) =>
			req.method === "PUT" ? jsonResponse(507, { error: { code: "quotaLimitReached", message: `${SERVER_MSG} ${NAME} ${CONTENT}` } }) : null;
		// No spaces or slashes: this name would pass the log code filter, so only discipline keeps it out.
		a.vault.write(`${NAME}-quota.md`, CONTENT);
		const quota = await a.engine.requestSync("command");
		assert.equal(quota.result, "failed");
		assert.equal(quota.errors[0]?.code, "quota");
		net.graph.intercept = null;

		// 7. The network drops: retries, then a partial run.
		net.dropNext = 1_000;
		const partial = await a.engine.requestSync("interval");
		assert.equal(partial.result, "partial");
		net.dropNext = 0;

		// 8. A Graph request that never answers: the timeout ends the run partial.
		net.hang = true;
		hangTimers = true;
		const timedOut = await a.engine.requestSync("interval");
		assert.equal(timedOut.result, "partial");
		assert.equal(timedOut.errors[0]?.code, "timeout");
		// ...and a token request that never answers (a device with no cached access token) ends it partial too.
		const cold = device(net, logger, "Cold", setTimer);
		const coldRun = await cold.engine.requestSync("interval");
		assert.equal(coldRun.result, "partial");
		assert.equal(coldRun.errors[0]?.code, "network", "AuthError network");
		net.hang = false;
		hangTimers = false;
		assert.equal((await a.engine.requestSync("command")).result, "ok", "the next run continues");

		// 9. The app is revoked: invalid_grant (whose description quotes the sentinels) → sign-in required.
		net.revoked = true;
		const fresh = device(net, logger, "Fresh", setTimer);
		const revoked = await fresh.engine.requestSync("command");
		assert.equal(revoked.result, "failed");
		assert.equal(fresh.auth.status, "sign-in-required");

		// The runs reached every phase and the logged failure paths (successful ops aren't logged one by one).
		const ops = new Set<string>(logger.entries().map((e) => e.op));
		for (const op of ["graph.request", "sync.run", "sync.pull", "sync.scan", "sync.plan", "sync.exec", "op.upload-new", "retry.backoff", "state.save"]) {
			assert.ok(ops.has(op), `the log has ${op}`);
		}
		assert.ok(
			logger.entries().some((e) => e.op === "sync.plan" && typeof e.durationMs === "number"),
			"the plan time is logged (M8 performance)",
		);
	} finally {
		for (const m of CONSOLE_METHODS) con[m] = saved.get(m);
	}

	const log = logger.serialize();
	assert.ok(log.length > 1_000, "the log has content");
	assert.ok(captured.length > 0, "console.debug mirrored the log (Verbose logging)");
	const haystacks: [string, string][] = [["log ring buffer", log], ...captured.map((c, i): [string, string] => [`console call ${i}`, c])];
	for (const [where, text] of haystacks) {
		for (const s of SENTINELS) {
			const at = text.indexOf(s);
			assert.ok(at < 0, `${where} contains the sentinel ${s}: …${text.slice(Math.max(0, at - 80), at + 80)}…`);
		}
	}
});
