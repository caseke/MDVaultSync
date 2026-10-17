// Engine (design §3, §5, §6.2; plan M6): single-flight lock, phases, union mode, preview and guard prompts,
// resync, the delta merge, crash injection and resume, the transform seam, and two devices converging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PENDING_HINTS, PROMPT_TIMEOUT_MS } from "../src/core/engine.ts";
import type { DeltaPage, PlanOp, RemoteItem, RemotePort, VaultPath } from "../src/core/ports.ts";
import { AuthError } from "../src/remote/auth.ts";
import { GraphError, NetworkError, ResyncRequired } from "../src/remote/errors.ts";
import { FakeRemote } from "./fakes/fake-remote.ts";
import { CrashSwitch, Device, UNIT, remoteFiles, vaultFiles } from "./fakes/device.ts";
import { STAMP } from "./fakes/plan-fixtures.ts";
import { deferred } from "./fakes/fake-http.ts";
import { XorTransform, withOverrides, xor } from "./fakes/sync-fakes.ts";
import { quickXorHash } from "../src/core/quickxor.ts";

/** Lets every queued promise continuation run (the engine reaches its next real wait). */
const tasks = () => new Promise<void>((res) => setImmediate(res));

function lcg(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	let x = seed * 2654435761;
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		b[i] = x >>> 24;
	}
	return b;
}

/** Syncs until a run changes nothing (at most `max` runs); returns how many runs it took. */
async function settle(d: Device, max = 3): Promise<number> {
	for (let i = 1; i <= max; i++) {
		const r = await d.sync("interval");
		if (r.result === "ok" && Object.entries(r.counts).every(([k, v]) => k === "skip" || v === 0)) return i;
	}
	assert.fail(`device did not settle in ${max} runs`);
}

function nothingToDo(r: { counts: Record<string, number> }): boolean {
	return Object.entries(r.counts).every(([k, v]) => k === "skip" || v === 0);
}

// ---------- first sync, union, preview ----------

test("first sync is a union merge with a preview; a second device joins without deletes (R-FIRST-1, R-FIRST-2)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { name: "A" });
	a.vault.write("n1.md", "one");
	a.vault.write("dir/n2.md", "two");
	const r1 = await a.sync("startup");
	assert.equal(r1.result, "ok");
	assert.equal(a.plans.length, 1, "preview shown before the first sync, even for an unattended trigger");
	assert.equal(a.plans[0]?.unionMode, true);
	assert.equal(remote.contentAt("dir/n2.md"), "two");
	assert.equal(a.store.state?.unionPending, false);
	assert.equal(a.store.state?.firstSyncCompleted, true);

	const b = new Device(remote, { name: "B" });
	b.vault.write("b-only.md", "b");
	await b.sync("startup");
	assert.deepEqual(vaultFiles(b.vault), { "b-only.md": "b", "dir/n2.md": "two", "n1.md": "one" });
	assert.equal(remote.contentAt("b-only.md"), "b");
	assert.equal(await settle(a), 2, "A downloads b-only.md, then is idle");
	assert.equal(await settle(b), 1);
	assert.equal(a.plans.length, 1, "no preview once union mode has ended");
});

test("preview cancel does nothing and keeps union mode; an unanswered preview times out as cancel", async () => {
	const remote = new FakeRemote();
	remote.putFile("r.md", "r");
	const a = new Device(remote, { confirmPlan: () => Promise.resolve(false) });
	a.vault.write("l.md", "l");
	const r = await a.sync("command");
	assert.equal(r.result, "cancelled");
	assert.equal(remote.contentAt("l.md"), null);
	assert.equal(a.vault.contentAt("r.md"), null);
	assert.equal(a.store.state?.unionPending, true);

	const never = deferred<boolean>();
	const b = new Device(remote, { confirmPlan: () => never.promise });
	const pending = b.sync("startup");
	for (let i = 0; i < 50 && b.clock.pending === 0; i++) await Promise.resolve();
	await tasks();
	assert.deepEqual(b.engine.status, { state: "waiting-for-user" });
	await b.clock.advance(PROMPT_TIMEOUT_MS);
	assert.equal((await pending).result, "cancelled");
	assert.equal(b.vault.contentAt("r.md"), null);
});

test("the preview command always shows the plan; previewEveryRun shows it on every run", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { settings: { previewEveryRun: true } });
	a.vault.write("x.md", "x");
	await a.sync("startup");
	await a.sync("interval");
	assert.equal(a.plans.length, 2);
	const b = new Device(remote);
	await b.sync("startup");
	await b.sync("preview");
	await b.sync("interval");
	assert.equal(b.plans.length, 2, "union preview, then the preview command; not the plain interval run");
});

// ---------- single-flight lock ----------

test("overlapping requestSync calls run one after another, with at most one rerun (R-TRIG-4)", async () => {
	const remote = new FakeRemote();
	const gate = deferred<boolean>();
	let first = true;
	const a = new Device(remote, {
		confirmPlan: () => {
			if (!first) return Promise.resolve(true);
			first = false;
			return gate.promise;
		},
	});
	let active = 0;
	let maxActive = 0;
	let lists = 0;
	const list = a.vault.list.bind(a.vault);
	a.vault.list = async () => {
		lists++;
		active++;
		maxActive = Math.max(maxActive, active);
		const out = await list();
		active--;
		return out;
	};
	a.vault.write("x.md", "x");
	const p1 = a.sync("startup");
	await tasks();
	const p2 = a.sync("command");
	const p3 = a.sync("ribbon");
	const p4 = a.sync("interval");
	assert.equal(p2, p1);
	assert.equal(p3, p1);
	assert.equal(p4, p1);
	gate.resolve(true);
	const report = await p1;
	assert.equal(lists, 2, "the first run plus exactly one rerun");
	assert.equal(maxActive, 1);
	// The rerun carries the strongest trigger asked for during the run (M7): "command" outranks the rest.
	assert.equal(report.trigger, "command");
	await a.sync("command");
	assert.equal(lists, 3, "a later request starts a new run");
});

// ---------- guard ----------

test("mass-delete guard: declining keeps the remote, remembers the deletes, and only 'Sync now' re-offers them (R-GUARD-1)", async () => {
	const remote = new FakeRemote();
	let answer = false;
	const a = new Device(remote, { confirmDeletes: () => Promise.resolve(answer) });
	for (const n of ["a", "b", "c", "d", "e"]) a.vault.write(`${n}.md`, n);
	await a.sync("startup");
	for (const n of ["a", "b", "c"]) a.vault.remove(`${n}.md`);
	const r = await a.sync("interval");
	assert.equal(a.deletePrompts.length, 1);
	assert.equal(a.deletePrompts[0]?.length, 3);
	assert.equal(r.counts["remote-delete"], 0);
	assert.ok(remote.contentAt("a.md"));
	assert.deepEqual(Object.keys(a.store.state?.declinedDeletes ?? {}).sort(), ["a.md", "b.md", "c.md"]);

	await a.sync("interval");
	assert.equal(a.deletePrompts.length, 1, "not re-proposed on the next interval run");

	answer = true;
	const now = await a.sync("command");
	assert.equal(a.deletePrompts.length, 2, "Sync now re-offers them");
	assert.equal(now.counts["remote-delete"], 3);
	assert.equal(remote.contentAt("a.md"), null);
	assert.deepEqual(a.store.state?.declinedDeletes, {});
});

test("an unanswered delete prompt times out as 'skip deletes'", async () => {
	const remote = new FakeRemote();
	const never = deferred<boolean>();
	const a = new Device(remote, { confirmDeletes: () => never.promise });
	for (const n of ["a", "b", "c"]) a.vault.write(`${n}.md`, n);
	await a.sync("startup");
	for (const n of ["a", "b"]) a.vault.remove(`${n}.md`);
	const p = a.sync("interval");
	await tasks();
	await a.clock.advance(PROMPT_TIMEOUT_MS);
	const r = await p;
	assert.equal(r.counts["remote-delete"], 0);
	assert.ok(remote.contentAt("a.md"));
});

// ---------- pull ----------

test("resync (410): re-enumerate in union mode, keep the bases, delete nothing [G-DL-4]", async () => {
	const remote = new FakeRemote();
	let resync = false;
	const a = new Device(remote, {
		remote: (r) =>
			withOverrides(r, {
				delta: (link: string | null): Promise<DeltaPage> => {
					if (resync && link !== null) {
						resync = false;
						return Promise.reject(new ResyncRequired(410, "resyncRequired"));
					}
					return r.delta(link);
				},
			}),
	});
	a.vault.write("keep.md", "k");
	a.vault.write("edit.md", "v1");
	await a.sync("startup");
	remote.remove("keep.md");
	a.vault.write("edit.md", "v2");
	resync = true;
	const r = await a.sync("interval");
	assert.equal(r.result, "ok");
	assert.equal(a.plans[a.plans.length - 1]?.unionMode, true, "union preview after the resync");
	assert.equal(r.counts["local-trash"], 0);
	assert.equal(remote.contentAt("keep.md"), "k", "restored, not deleted");
	assert.equal(remote.contentAt("edit.md"), "v2", "a one-sided edit syncs normally");
	assert.equal(r.counts.conflict, 0);
	assert.equal(a.store.state?.unionPending, false);
});

test("delta merge: a deleted folder takes its descendants out of the index even when delta omits them", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, {
		remote: (r) =>
			withOverrides(r, {
				delta: async (link: string | null): Promise<DeltaPage> => {
					const page = await r.delta(link);
					// Consumer OneDrive may list only the folder's tombstone [G-DL-5].
					return { ...page, items: page.items.filter((i) => !i.deleted || i.isFolder) };
				},
			}),
	});
	a.vault.write("f/a.md", "a");
	a.vault.write("f/s/b.md", "b");
	for (const n of ["1", "2", "3", "4", "5", "6", "7", "8"]) a.vault.write(`keep${n}.md`, n);
	await a.sync("startup");
	const ids = ["f", "f/a.md", "f/s", "f/s/b.md"].map((p) => remote.itemAt(p)?.id as string);
	remote.remove("f");
	const r = await a.sync("interval");
	for (const id of ids) assert.equal(a.store.state?.remoteIndex[id], undefined);
	assert.equal(r.counts["local-trash"], 2, "the two files");
	assert.equal(a.vault.contentAt("f/s/b.md"), null);
	// Folders are dealt with when the scan finds them empty (design §5.4), which is the next run. FakeVault's
	// folders exist only through their files, so here they are already gone and their records are forgotten.
	await a.sync("interval");
	assert.deepEqual(Object.keys(a.store.state?.folders ?? {}), []);
	assert.deepEqual(a.store.state?.files["f/a.md" as VaultPath], undefined);
});

test("a missing token stops the run as sign-in required; local state is kept", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	a.vault.write("x.md", "x");
	await a.sync("startup");
	const saved = a.store.json;
	const engine = a.restart();
	(engine as unknown as { deps: { ensureSignedIn: () => Promise<void> } }).deps.ensureSignedIn = () => Promise.reject(new AuthError("sign-in-required"));
	const r = await a.sync("interval");
	assert.equal(r.result, "failed");
	assert.deepEqual(a.engine.status, { state: "sign-in-required" });
	assert.equal(a.store.json, saved, "state untouched");
});

// ---------- crash injection and resume (T-D4, R-RES-3) ----------

interface Snapshot {
	vault: Record<string, string>;
	remote: Record<string, string>;
}

/** A synced device, then a change of every kind on both sides. Returns the device ready to sync. */
async function scenario(crash: CrashSwitch): Promise<{ remote: FakeRemote; dev: Device }> {
	const remote = new FakeRemote();
	const dev = new Device(remote, { name: "A", crash });
	for (const n of ["a", "b", "c", "d", "e", "r", "s"]) dev.vault.write(`${n}.md`, n);
	dev.vault.write("folder/x.md", "x");
	dev.vault.write("big.bin", lcg(2 * UNIT + 100, 1));
	await dev.sync("startup");
	// Another device or the OneDrive web UI:
	remote.putFile("b.md", "b remote edit");
	remote.putFile("m.md", "m new remote");
	remote.remove("e.md");
	remote.rename("s.md", "sub/s.md");
	remote.putFile("c.md", "c remote edit");
	// This device:
	dev.vault.write("a.md", "a local edit");
	dev.vault.write("n.md", "n new local");
	dev.vault.remove("d.md");
	dev.vault.rename("r.md", "r2.md");
	dev.vault.write("c.md", "c local edit");
	dev.vault.write("big.bin", lcg(2 * UNIT + 100, 2));
	return { remote, dev };
}

async function snapshotAfter(dev: Device, remote: FakeRemote): Promise<Snapshot> {
	await settle(dev);
	return { vault: vaultFiles(dev.vault), remote: remoteFiles(remote) };
}

test("crash injection: a crash after any mutating call, then a restart, converges to the same result", async () => {
	const ref = new CrashSwitch();
	const { remote: r0, dev: d0 } = await scenario(ref);
	const start = ref.count;
	const reference = await snapshotAfter(d0, r0);
	const total = ref.count - start;
	assert.ok(total >= 12, `scenario exercises many mutations (${total})`);
	const copy = `c (conflict A ${STAMP}).md`;
	assert.equal(reference.vault[copy], "c local edit");
	assert.equal(reference.remote[copy], "c local edit");
	assert.equal(reference.vault["c.md"], "c remote edit");
	assert.deepEqual(reference.vault, Object.fromEntries(Object.entries(reference.remote).map(([p, c]) => [p, c])));

	for (let n = 0; n < total; n++) {
		const sw = new CrashSwitch();
		const { remote, dev } = await scenario(sw);
		sw.limit = sw.count + n;
		await dev.sync("interval");
		assert.ok(sw.dead, `crashed at mutation ${n}`);
		dev.restart({ crash: undefined });
		const got = await snapshotAfter(dev, remote);
		assert.deepEqual(got, reference, `converged after a crash at mutation ${n}`);
		assert.equal(Object.keys(got.vault).filter((p) => p.includes("(conflict")).length, 1, `one conflict copy after crash ${n}`);
	}
});

test("conflict crash: a crash after the copy is written reuses the same copy path (no second copy)", async () => {
	const sw = new CrashSwitch();
	const remote = new FakeRemote();
	const dev = new Device(remote, { name: "A", crash: sw });
	dev.vault.write("n.md", "base");
	await dev.sync("startup");
	dev.vault.write("n.md", "mine");
	remote.putFile("n.md", "theirs");
	// The conflict writes the copy (1 mutation), then the original: die right there.
	sw.limit = sw.count + 1;
	await dev.sync("interval");
	assert.ok(sw.dead);
	const copy = `n (conflict A ${STAMP}).md`;
	assert.equal(dev.vault.contentAt(copy), "mine");
	assert.equal(dev.vault.contentAt("n.md"), "mine", "original untouched before the crash");
	assert.equal(dev.store.state?.pendingConflicts["n.md" as VaultPath]?.copyPath, copy);
	dev.restart({ crash: undefined });
	dev.clock.t += 60_000; // a later run would pick a new timestamp if it didn't reuse the copy
	await settle(dev);
	assert.deepEqual(vaultFiles(dev.vault), { [copy]: "mine", "n.md": "theirs" });
	assert.deepEqual(remoteFiles(remote), { [copy]: "mine", "n.md": "theirs" });
});

test("union crash: a crash during the first sync after the delta save leaves union mode on; no deletes follow", async () => {
	const sw = new CrashSwitch();
	const remote = new FakeRemote();
	for (const n of ["r1", "r2", "r3"]) remote.putFile(`${n}.md`, n);
	const dev = new Device(remote, { crash: sw });
	for (const n of ["l1", "l2", "l3"]) dev.vault.write(`${n}.md`, n);
	sw.limit = 2;
	await dev.sync("startup");
	assert.ok(sw.dead);
	const saved = dev.store.state;
	assert.ok(saved?.deltaLink, "the pull was saved");
	assert.equal(saved?.unionPending, true);
	// Meanwhile the remote loses a file this device never saw, and this device deletes one it had.
	remote.remove("r1.md");
	dev.vault.remove("l1.md");
	dev.restart({ crash: undefined });
	const r = await dev.sync("interval");
	assert.equal(dev.plans[dev.plans.length - 1]?.unionMode, true);
	assert.equal(r.counts["remote-delete"] + r.counts["local-trash"], 0);
	await settle(dev);
	for (const n of ["r2", "r3", "l2", "l3"]) assert.ok(dev.vault.contentAt(`${n}.md`) && remote.contentAt(`${n}.md`));
});

// ---------- transform seam (R-ENG-4) ----------

test("transform seam: with an XOR transform the remote holds only transformed bytes; both vaults hold plaintext", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { name: "A", transform: new XorTransform() });
	const b = new Device(remote, { name: "B", transform: new XorTransform() });
	a.vault.write("note.md", "secret plaintext");
	a.vault.write("big.bin", lcg(2 * UNIT + 7, 3));
	await a.sync("startup");
	await b.sync("startup");
	b.vault.write("note.md", "edited on B");
	await settle(b);
	await settle(a);
	const stored = remote.itemAt("note.md");
	assert.ok(stored);
	const raw = new Uint8Array(await remote.download(stored.id));
	assert.equal(new TextDecoder().decode(new Uint8Array(xor(raw.buffer))), "edited on B");
	assert.ok(!new TextDecoder().decode(raw).includes("edited"), "no plaintext stored remotely");
	assert.equal(a.vault.contentAt("note.md"), "edited on B");
	assert.deepEqual([...(a.vault.files.get("big.bin")?.data ?? [])], [...lcg(2 * UNIT + 7, 3)]);
	assert.deepEqual([...(b.vault.files.get("big.bin")?.data ?? [])], [...lcg(2 * UNIT + 7, 3)]);
	assert.equal(a.store.state?.files["note.md" as VaultPath]?.transformId, "xor-test");
});

// ---------- two devices, 1,000 files ----------

test("1,000 files through two vaults and one remote converge in at most 2 runs per device, losing nothing", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { name: "A", settings: { massDeleteThresholdPct: 100 } });
	const b = new Device(remote, { name: "B", settings: { massDeleteThresholdPct: 100 } });
	const written = new Map<string, string>(); // every version either device wrote
	const write = (d: Device, p: string, c: string) => {
		d.vault.write(p, c);
		written.set(`${p}\u0000${c}`, c);
	};
	for (let i = 0; i < 1000; i++) write(a, `f${i % 10}/note-${i}.md`, `note ${i}`);
	await a.sync("startup");
	await b.sync("startup");
	assert.equal(Object.keys(vaultFiles(b.vault)).length, 1000);

	// Concurrent work on both devices.
	for (let i = 0; i < 50; i++) write(a, `f${i % 10}/note-${i}.md`, `A edit ${i}`);
	for (let i = 50; i < 100; i++) write(b, `f${i % 10}/note-${i}.md`, `B edit ${i}`);
	for (let i = 100; i < 105; i++) {
		write(a, `f${i % 10}/note-${i}.md`, `A both ${i}`);
		write(b, `f${i % 10}/note-${i}.md`, `B both ${i}`);
	}
	for (let i = 200; i < 210; i++) a.vault.remove(`f${i % 10}/note-${i}.md`);
	for (let i = 300; i < 310; i++) b.vault.rename(`f${i % 10}/note-${i}.md`, `moved/note-${i}.md`);
	for (let i = 0; i < 20; i++) write(b, `b-new/n${i}.md`, `new on B ${i}`);

	const runs = { a: 0, b: 0 };
	for (let round = 0; round < 2; round++) {
		for (const [d, k] of [
			[a, "a"],
			[b, "b"],
		] as const) {
			const r = await d.sync("interval");
			if (!nothingToDo(r)) runs[k]++;
			assert.notEqual(r.result, "failed");
		}
	}
	const ra = await a.sync("interval");
	const rb = await b.sync("interval");
	assert.ok(nothingToDo(ra) && nothingToDo(rb), "both devices are idle");
	assert.ok(runs.a <= 2 && runs.b <= 2, `runs per device ${JSON.stringify(runs)}`);
	const va = vaultFiles(a.vault);
	assert.deepEqual(va, vaultFiles(b.vault));
	assert.deepEqual(va, remoteFiles(remote));
	assert.equal(Object.keys(va).filter((p) => p.includes("(conflict")).length, 5);
	// Zero data loss: every version written survives somewhere, except the ones it was replaced by on purpose
	// (an older edit superseded by a newer one on the same device) and the deliberate deletes.
	const present = new Set(Object.values(va));
	for (let i = 0; i < 50; i++) assert.ok(present.has(`A edit ${i}`));
	for (let i = 50; i < 100; i++) assert.ok(present.has(`B edit ${i}`));
	for (let i = 100; i < 105; i++) assert.ok(present.has(`A both ${i}`) && present.has(`B both ${i}`), `both versions of ${i}`);
	for (let i = 0; i < 20; i++) assert.ok(present.has(`new on B ${i}`));
	for (let i = 300; i < 310; i++) assert.equal(va[`moved/note-${i}.md`], `note ${i}`);
	for (let i = 200; i < 210; i++) assert.ok(remote.recycleBin.some((it) => it.name === `note-${i}.md`), "deletes are recoverable");
});

test("excluded paths are never uploaded or overwritten (R-SCOPE-2, R-SCOPE-4)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { settings: { excludePatterns: ["private/"] } });
	a.vault.write("private/secret.md", "s");
	a.vault.write("open.md", "o");
	await a.sync("startup");
	assert.equal(remote.contentAt("private/secret.md"), null, "excluded files are never uploaded");
	const ops: PlanOp[] = a.plans[0]?.ops ?? [];
	assert.ok(ops.some((o) => o.kind === "skip" && o.path === "private/secret.md"));
	remote.putFile("private/secret.md", "remote version");
	remote.remove("open.md");
	await a.sync("interval");
	assert.equal(a.vault.contentAt("private/secret.md"), "s", "an excluded path is never written from remote");
});

// ---------- M7: rerun trigger, echo filter, approot prefix ----------

/** Makes the next vault.list() wait for `gate`, so a test can request syncs while a run is in progress. */
function holdNextList(d: Device): { gate: ReturnType<typeof deferred<void>>; entered: Promise<void> } {
	const gate = deferred<void>();
	const entered = deferred<void>();
	const list = d.vault.list.bind(d.vault);
	let held = false;
	d.vault.list = async () => {
		if (!held) {
			held = true;
			entered.resolve();
			await gate.promise;
		}
		return list();
	};
	return { gate, entered: entered.promise };
}

test("'Preview sync' pressed during a run makes the rerun a preview, never a silent sync (design §10)", async () => {
	const remote = new FakeRemote();
	let answer = true;
	const a = new Device(remote, { confirmPlan: () => Promise.resolve(answer) });
	a.vault.write("x.md", "x");
	await a.sync("startup");
	const plansBefore = a.plans.length;
	const { gate, entered } = holdNextList(a);
	const list = a.vault.list.bind(a.vault);
	let calls = 0;
	a.vault.list = () => {
		// A new file appears after the first run listed the vault: only the rerun can see it.
		if (++calls === 2) a.vault.write("y.md", "y");
		return list();
	};
	const p1 = a.sync("interval");
	await entered;
	answer = false;
	const p2 = a.sync("preview");
	assert.equal(p2, p1);
	gate.resolve();
	const report = await p1;
	assert.equal(report.trigger, "preview");
	assert.equal(report.result, "cancelled", "the user cancelled the preview, so nothing ran");
	assert.equal(a.plans.length, plansBefore + 1, "the rerun showed the plan");
	assert.equal(remote.contentAt("y.md"), null, "nothing uploaded without Run");
});

test("'Sync now' pressed during an interval run re-offers declined deletes in the rerun (R-GUARD-1)", async () => {
	const remote = new FakeRemote();
	let answer = false;
	const a = new Device(remote, { confirmDeletes: () => Promise.resolve(answer) });
	for (const n of ["a", "b", "c", "d", "e"]) a.vault.write(`${n}.md`, n);
	await a.sync("startup");
	for (const n of ["a", "b", "c"]) a.vault.remove(`${n}.md`);
	await a.sync("interval");
	assert.equal(a.deletePrompts.length, 1);
	answer = true;
	const { gate, entered } = holdNextList(a);
	const p = a.sync("interval");
	await entered;
	void a.sync("command");
	gate.resolve();
	const report = await p;
	assert.equal(report.trigger, "command");
	assert.equal(a.deletePrompts.length, 2, "the rerun re-offered the declined deletes");
	assert.equal(report.counts["remote-delete"], 3);
});

test("echo filter: our own write's vault event plans nothing, and the scan consumes expectedWrites (T-D8)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	await a.sync("startup");
	remote.putFile("n.md", "from remote");
	await a.sync("interval");
	assert.equal(a.vault.contentAt("n.md"), "from remote");
	assert.equal(a.engine.expectedWrites.size, 1, "the download registered an expected write");
	// The vault event for our own write arrives (events are never dropped, design §3).
	a.engine.noteLocalChange({ kind: "dirty", path: "n.md" as VaultPath });
	const r = await a.sync("interval");
	assert.ok(nothingToDo(r), "an echo is a no-op");
	assert.equal(a.engine.expectedWrites.size, 0, "the scan consumed the entry");
	// A real edit at the same path is never swallowed.
	await a.sync("interval");
	a.vault.write("n.md", "edited here");
	a.engine.noteLocalChange({ kind: "dirty", path: "n.md" as VaultPath });
	const r2 = await a.sync("interval");
	assert.equal(r2.counts["upload-replace"], 1);
	assert.equal(remote.contentAt("n.md"), "edited here");
});

test("an edit made right after our download (before the event arrives) still uploads", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	await a.sync("startup");
	remote.putFile("n.md", "from remote");
	await a.sync("interval");
	a.vault.write("n.md", "typed");
	a.engine.noteLocalChange({ kind: "dirty", path: "n.md" as VaultPath });
	const r = await a.sync("interval");
	assert.equal(r.counts["upload-replace"], 1);
	assert.equal(remote.contentAt("n.md"), "typed");
});

test("pathPrefixLen is the approot path prefix length without its leading slash, once preflight ran", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	assert.equal(a.engine.pathPrefixLen, null);
	await a.sync("startup");
	assert.equal(a.engine.pathPrefixLen, "Apps/MDVaultSync".length);
});

test("onReport sees every run's report, the first run's conflicts included when a rerun follows", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	a.vault.write("n.md", "base");
	await a.sync("startup");
	a.vault.write("n.md", "local edit");
	a.engine.noteLocalChange({ kind: "dirty", path: "n.md" as VaultPath });
	remote.putFile("n.md", "remote edit");
	const before = a.reports.length;
	const { gate, entered } = holdNextList(a);
	const p = a.sync("interval");
	await entered;
	void a.sync("interval");
	gate.resolve();
	const last = await p;
	const runs = a.reports.slice(before);
	assert.equal(runs.length, 2, "the run and its rerun");
	assert.equal(runs[0]?.conflicts.length, 1, "the first run's conflict reaches the hook");
	assert.equal(last, runs[1], "requestSync resolves with the last run's report");
	assert.equal(last.conflicts.length, 0);
});

test("echoes of our own local move and trash (renamed / deleted events) plan nothing (T-D8)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	a.vault.write("old.md", "o");
	a.vault.write("gone.md", "g");
	await a.sync("startup");
	remote.rename("old.md", "new.md");
	remote.remove("gone.md");
	const r1 = await a.sync("interval");
	assert.equal(r1.counts["local-move"], 1);
	assert.equal(r1.counts["local-trash"], 1);
	// The vault events for those two writes arrive after the run.
	a.engine.noteLocalChange({ kind: "renamed", from: "old.md" as VaultPath, to: "new.md" as VaultPath });
	a.engine.noteLocalChange({ kind: "deleted", path: "gone.md" as VaultPath });
	const r2 = await a.sync("interval");
	assert.ok(nothingToDo(r2), JSON.stringify(r2.counts));
	assert.equal(remote.contentAt("new.md"), "o");
	assert.equal(remote.contentAt("gone.md"), null);
});

// ---------- M7 security-review fixes ----------

test("reset() during a run drops a queued rerun: no run starts after unload or sign-out", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	a.vault.write("x.md", "x");
	await a.sync("startup");
	let lists = 0;
	const { gate, entered } = holdNextList(a);
	const list = a.vault.list.bind(a.vault);
	a.vault.list = () => {
		lists++;
		return list();
	};
	const p = a.sync("interval");
	await entered;
	void a.sync("command");
	a.engine.reset();
	gate.resolve();
	await p;
	assert.equal(lists, 1, "only the run that was already going listed the vault");
	a.vault.write("y.md", "y");
	await tasks();
	assert.equal(remote.contentAt("y.md"), null);
});

test("a cancelled preview drops reruns from unattended triggers, but keeps one from a user action", async () => {
	const remote = new FakeRemote();
	const gate = deferred<boolean>();
	let first = true;
	const a = new Device(remote, {
		confirmPlan: () => {
			if (!first) return Promise.resolve(false);
			first = false;
			return gate.promise;
		},
	});
	a.vault.write("x.md", "x");
	const p = a.sync("startup");
	for (let i = 0; i < 50 && a.plans.length === 0; i++) await tasks();
	void a.sync("interval");
	gate.resolve(false);
	await p;
	assert.equal(a.plans.length, 1, "Cancel isn't followed by the same preview from a queued timer run");

	const gate2 = deferred<boolean>();
	let again = true;
	const b = new Device(remote, {
		confirmPlan: () => {
			if (!again) return Promise.resolve(false);
			again = false;
			return gate2.promise;
		},
	});
	const q = b.sync("startup");
	for (let i = 0; i < 50 && b.plans.length === 0; i++) await tasks();
	void b.sync("preview");
	gate2.resolve(false);
	await q;
	assert.equal(b.plans.length, 2, "a preview the user asked for during the run still shows");
});

test("'Sync now' and 'Preview sync' both pressed during a run: the rerun previews and still re-offers declined deletes", async () => {
	const remote = new FakeRemote();
	let answer = false;
	const a = new Device(remote, { confirmDeletes: () => Promise.resolve(answer) });
	for (const n of ["a", "b", "c", "d", "e"]) a.vault.write(`${n}.md`, n);
	await a.sync("startup");
	for (const n of ["a", "b", "c"]) a.vault.remove(`${n}.md`);
	await a.sync("interval");
	answer = true;
	const plansBefore = a.plans.length;
	const { gate, entered } = holdNextList(a);
	const p = a.sync("interval");
	await entered;
	void a.sync("command");
	void a.sync("preview");
	gate.resolve();
	const r = await p;
	assert.equal(r.trigger, "preview");
	assert.equal(a.plans.length, plansBefore + 1);
	assert.equal(r.counts["remote-delete"], 3, "the re-offer survived");
});

test("local-change hints: repeats are dropped; past the cap the next run re-hashes everything instead of losing edits", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	a.vault.write("n.md", "x");
	a.vault.write("m.md", "same size");
	await a.sync("startup");
	for (let i = 0; i < 1000; i++) a.engine.noteLocalChange({ kind: "dirty", path: "n.md" as VaultPath });
	assert.equal(a.engine.pendingHintCount, 1, "a repeat of the last hint adds nothing");
	for (let i = 0; i < MAX_PENDING_HINTS + 50; i++) a.engine.noteLocalChange({ kind: "dirty", path: `f${i}.md` as VaultPath });
	assert.ok(a.engine.pendingHintCount <= MAX_PENDING_HINTS);
	// An edit that keeps size and mtime (the worst case for the stat check) is still found: over the cap, the
	// next run re-hashes every file.
	const rec = a.store.state?.files["m.md" as VaultPath];
	assert.ok(rec);
	a.vault.write("m.md", "SAME SIZE");
	const f = a.vault.files.get("m.md");
	assert.ok(f);
	f.mtime = rec.mtime;
	const r = await a.sync("interval");
	assert.equal(r.counts["upload-replace"], 1);
	assert.equal(remote.contentAt("m.md"), "SAME SIZE");
	// After an ok run the full re-hash ends.
	a.vault.write("m.md", "SAME_SIZE");
	const g = a.vault.files.get("m.md");
	assert.ok(g);
	g.mtime = a.store.state?.files["m.md" as VaultPath]?.mtime ?? 0;
	const r2 = await a.sync("interval");
	assert.equal(r2.counts["upload-replace"], 0, "back to the stat check (this edit is invisible without a hint)");
});

test("rename hints are kept past the cap (they protect records of files renamed to names OneDrive refuses)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	await a.sync("startup");
	for (let i = 0; i < MAX_PENDING_HINTS; i++) a.engine.noteLocalChange({ kind: "dirty", path: `f${i}.md` as VaultPath });
	const before = a.engine.pendingHintCount;
	a.engine.noteLocalChange({ kind: "renamed", from: "a.md" as VaultPath, to: "a:b.md" as VaultPath });
	assert.equal(a.engine.pendingHintCount, before + 1);
});

test("a hint equal to one the running sync will clear is kept (an edit right after our download is never swallowed)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	a.vault.write("n.md", "base");
	await a.sync("startup");
	a.engine.noteLocalChange({ kind: "dirty", path: "n.md" as VaultPath }); // e.g. the echo of an earlier download
	remote.putFile("n.md", "newer remote");
	const write = a.vault.writeAtomic.bind(a.vault);
	a.vault.writeAtomic = async (p, d) => {
		await write(p, d);
		// The user's edit lands right after our write, before the run ends; its event repeats the last hint.
		if (p === "n.md") a.engine.noteLocalChange({ kind: "dirty", path: "n.md" as VaultPath });
	};
	const r = await a.sync("interval");
	assert.equal(r.result, "ok");
	assert.equal(a.engine.pendingHintCount, 1, "the new hint survives the run's cleanup");
});

test("a sync requested after reset() while the old run is still settling starts a fresh run", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote);
	await a.sync("startup");
	let lists = 0;
	const { gate, entered } = holdNextList(a);
	const list = a.vault.list.bind(a.vault);
	a.vault.list = () => {
		lists++;
		return list();
	};
	const old = a.sync("interval");
	await entered;
	a.engine.reset();
	const fresh = a.sync("command");
	assert.notEqual(fresh, old);
	gate.resolve();
	await old;
	const r = await fresh;
	assert.equal(r.trigger, "command");
	assert.equal(lists, 2, "the old run and a new one");
});

test("the full re-hash after a hint overflow stays pending through a cancelled run and a reset (third review)", async () => {
	const remote = new FakeRemote();
	let answer = true;
	const a = new Device(remote, { confirmPlan: () => Promise.resolve(answer), settings: { previewEveryRun: true } });
	a.vault.write("m.md", "same size");
	await a.sync("startup");
	const sneak = (text: string) => {
		const mtime = a.store.state?.files["m.md" as VaultPath]?.mtime ?? 0;
		a.vault.write("m.md", text);
		const f = a.vault.files.get("m.md");
		assert.ok(f);
		f.mtime = mtime; // same size, same mtime: only a re-hash can see it
	};
	for (let i = 0; i < MAX_PENDING_HINTS + 1; i++) a.engine.noteLocalChange({ kind: "dirty", path: `f${i}.md` as VaultPath });
	sneak("SAME SIZE");
	answer = false;
	assert.equal((await a.sync("interval")).result, "cancelled");
	// A reset mid-run (sign-out) doesn't clear it either.
	answer = true;
	const { gate, entered } = holdNextList(a);
	const p = a.sync("interval");
	await entered;
	a.engine.reset();
	gate.resolve();
	await p;
	const r = await a.sync("interval");
	assert.equal(r.counts["upload-replace"], 1, "still re-hashed after the cancel and the reset");
	assert.equal(remote.contentAt("m.md"), "SAME SIZE");
});

// ---------- M8 hardening ----------

test("a full drive (507) mid-run fails the run as quota, keeps what was done, and retries cleanly after space is freed (T-D7)", async () => {
	const remote = new FakeRemote();
	let full = false;
	let uploads = 0;
	const a = new Device(remote, {
		concurrency: 1,
		remote: (r) =>
			withOverrides(r, {
				uploadNew: (parentId: string, name: string, data: ArrayBuffer) => {
					if (full && ++uploads > 1) return Promise.reject(new GraphError(507, "quotaLimitReached"));
					return r.uploadNew(parentId, name, data);
				},
			}),
	});
	a.vault.write("first.md", "1");
	await a.sync("startup");
	full = true;
	for (const n of ["b", "c", "d"]) a.vault.write(`${n}.md`, n);
	const r = await a.sync("interval");
	assert.equal(r.result, "failed");
	assert.equal(r.errors[0]?.code, "quota");
	assert.deepEqual(a.engine.status, { state: "error", code: "quota" });
	const uploaded = Object.keys(remoteFiles(remote)).filter((p) => p !== "first.md");
	assert.equal(uploaded.length, 1, "the upload before the 507 landed");
	assert.ok(a.store.state?.files[uploaded[0] as VaultPath], "and its record was saved");
	full = false;
	const again = await a.sync("interval");
	assert.equal(again.result, "ok");
	assert.deepEqual(Object.keys(remoteFiles(remote)).sort(), ["b.md", "c.md", "d.md", "first.md"]);
});

/** The remote as OneDrive may show a file right after a large upload: no quickXorHash yet [G-DL-8]. */
function hashless(r: RemotePort): RemotePort {
	const strip = (it: RemoteItem): RemoteItem => (it.isFolder ? it : { ...it, quickXorHash: null });
	return withOverrides(r, {
		delta: async (link: string | null) => {
			const page = await r.delta(link);
			return { ...page, items: page.items.map(strip) };
		},
		getItem: async (id: string) => {
			const it = await r.getItem(id);
			return it && strip(it);
		},
		getChildByName: async (parentId: string, name: string) => {
			const it = await r.getChildByName(parentId, name);
			return it && strip(it);
		},
	});
}

test("an upload whose commit answer was lost, then listed with no hash, is adopted: no conflict copy for identical bytes (M8 matrix row 2)", async () => {
	const remote = new FakeRemote();
	let dropCommit = true;
	const a = new Device(remote, {
		remote: (r) =>
			hashless(
				withOverrides(r, {
					// The final fragment commits on OneDrive, then airplane mode eats the answer.
					putFragment: async (url: string, start: number, total: number, data: ArrayBuffer) => {
						const item = await r.putFragment(url, start, total, data);
						if (item && dropCommit) {
							dropCommit = false;
							throw new NetworkError();
						}
						return item;
					},
				}),
			),
	});
	a.vault.write("first.md", "1");
	await a.sync("startup");
	const big = lcg(2 * UNIT + 100, 7);
	a.vault.write("big.bin", big);
	const r1 = await a.sync("command");
	assert.equal(r1.result, "partial", "the lost answer ends the run partial");
	const r2 = await a.sync("command");
	assert.equal(r2.result, "ok");
	assert.equal(r2.conflicts.length, 0, "identical bytes: no conflict copy");
	assert.deepEqual(Object.keys(vaultFiles(a.vault)).sort(), ["big.bin", "first.md"]);
	assert.deepEqual(Object.keys(remoteFiles(remote)).sort(), ["big.bin", "first.md"]);
	assert.ok(a.store.state?.files["big.bin" as VaultPath], "the pair is recorded as synced");
	assert.equal(await settle(a), 1);
});

test("a no-history pair with no remote hash and different bytes still gets a conflict copy (M8 matrix row 2)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { remote: hashless });
	a.vault.write("first.md", "1");
	await a.sync("startup");
	remote.putFile("n.md", "theirs");
	a.vault.write("n.md", "mine!!");
	const r = await a.sync("command");
	assert.equal(r.conflicts.length, 1);
	assert.equal(a.vault.contentAt("n.md"), "theirs");
	assert.equal(a.vault.contentAt(r.conflicts[0]?.copyPath ?? ""), "mine!!");
});

test("a no-history pair with no remote hash and the same bytes is adopted without a copy (M8 matrix row 2)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { remote: hashless });
	a.vault.write("first.md", "1");
	await a.sync("startup");
	remote.putFile("n.md", "same");
	a.vault.write("n.md", "same");
	const r = await a.sync("command");
	assert.equal(r.result, "ok");
	assert.equal(r.conflicts.length, 0);
	assert.deepEqual(Object.keys(vaultFiles(a.vault)).sort(), ["first.md", "n.md"]);
	assert.equal(await settle(a), 1);
});

test("step 0 adopt: an edit made while the remote bytes download isn't masked; the next run uploads it (M8 review)", async () => {
	const remote = new FakeRemote();
	let editDuring = false;
	const a = new Device(remote, {
		remote: (r) =>
			hashless(
				withOverrides(r, {
					download: async (id: string, size?: number) => {
						const bytes = await r.download(id, size);
						if (editDuring) {
							editDuring = false;
							a.vault.write("n.md", "edited during the download");
						}
						return bytes;
					},
				}),
			),
	});
	a.vault.write("first.md", "1");
	await a.sync("startup");
	remote.putFile("n.md", "same");
	a.vault.write("n.md", "same");
	editDuring = true;
	const r = await a.sync("command");
	assert.equal(r.conflicts.length, 0);
	await a.sync("interval");
	assert.equal(remote.contentAt("n.md"), "edited during the download", "the edit reached OneDrive");
	assert.equal(a.vault.contentAt("n.md"), "edited during the download");
});

test("step 0 adopt works through a non-identity transform (stored bytes are compared, R-ENG-4)", async () => {
	const remote = new FakeRemote();
	const a = new Device(remote, { remote: hashless, transform: new XorTransform() });
	a.vault.write("first.md", "1");
	await a.sync("startup");
	remote.putFile("n.md", new Uint8Array(xor(new TextEncoder().encode("same").buffer)));
	a.vault.write("n.md", "same");
	const r = await a.sync("command");
	assert.equal(r.result, "ok");
	assert.equal(r.conflicts.length, 0);
	assert.equal(a.vault.contentAt("n.md"), "same");
});

test("step 0 with downloaded bytes compares bytes, not just the non-cryptographic hash (M8 review, T-T4)", async () => {
	// QuickXorHash is XOR-linear and its bit positions repeat every 160 bytes: flipping the same bit in bytes 0
	// and 160 keeps the hash and the length. A remote listed without a hash must not be adopted on the hash alone.
	const mineBytes = lcg(200, 3);
	const theirsBytes = mineBytes.slice();
	theirsBytes[0] = (theirsBytes[0] as number) ^ 1;
	theirsBytes[160] = (theirsBytes[160] as number) ^ 1;
	assert.equal(quickXorHash(mineBytes), quickXorHash(theirsBytes), "a real collision");
	const remote = new FakeRemote();
	const a = new Device(remote, { remote: hashless });
	a.vault.write("first.md", "1");
	await a.sync("startup");
	remote.putFile("n.bin", theirsBytes);
	a.vault.write("n.bin", mineBytes);
	const r = await a.sync("command");
	assert.equal(r.conflicts.length, 1, "different bytes keep both versions");
	assert.deepEqual(a.vault.files.get("n.bin")?.data, theirsBytes, "OneDrive's version keeps the name");
	assert.deepEqual(a.vault.files.get(r.conflicts[0]?.copyPath ?? "")?.data, mineBytes, "this device's version is in the copy");
});
