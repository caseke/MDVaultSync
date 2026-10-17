// Performance (plan M8): a 5,000-file vault plans in under 2 s on desktop. Timed with performance.now(); the
// durations are reported as test diagnostics (they show in `npm test` output and in docs/plan.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { plan, type ScannedEntry } from "../src/core/planner.ts";
import { emptyState } from "../src/core/state.ts";
import type { Plan } from "../src/core/ports.ts";
import { SETTINGS, world, type World } from "./fakes/plan-fixtures.ts";

const FILES = 5_000;
const FOLDERS = 250;
const LIMIT_MS = 2_000;

function files(): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < FILES; i++) out[`folder ${i % FOLDERS}/sub ${i % 7}/note ${i}.md`] = `# Note ${i}\n\n${"body ".repeat(i % 50)}`;
	return out;
}

/** Plans `runs` times and returns the slowest, so one GC pause can't hide a slow planner, nor fake a fast one. */
function timed(w: World, local: ScannedEntry[], state = w.state, runs = 3): { ms: number; result: Plan } {
	let worst = 0;
	let result: Plan | null = null;
	for (let i = 0; i < runs; i++) {
		const s = structuredClone(state);
		const t0 = performance.now();
		result = plan(s, local, w.remote.index(), SETTINGS);
		worst = Math.max(worst, performance.now() - t0);
	}
	return { ms: worst, result: result as Plan };
}

const counts = (p: Plan) => Object.entries(p.ops.reduce<Record<string, number>>((m, o) => ({ ...m, [o.kind]: (m[o.kind] ?? 0) + 1 }), {}));

test(`${FILES} files in ${FOLDERS} folders plan in under ${LIMIT_MS} ms (first sync, steady state, busy day)`, async (t) => {
	const w = world(files());
	const local = await w.vault.scan();
	assert.equal(local.filter((e) => !e.isFolder).length, FILES);

	// 1. A device joining an existing remote vault: union mode, nothing recorded yet.
	const first = timed(w, local, emptyState("device-2"));
	assert.equal(first.result.unionMode, true);
	assert.equal(first.result.deleteCount, 0);
	t.diagnostic(`first sync (union): ${first.ms.toFixed(1)} ms, ${first.result.ops.length} ops`);

	// 2. Steady state: everything synced, nothing changed.
	const steady = timed(w, local);
	assert.equal(steady.result.ops.filter((o) => o.kind !== "skip").length, 0);
	t.diagnostic(`steady state: ${steady.ms.toFixed(1)} ms, ${steady.result.ops.length} ops`);

	// 3. A busy day: 10 % edited here, 10 % edited remotely, 1 % deleted on each side, 1 % renamed remotely, 100 new.
	const paths = Object.keys(files());
	for (let i = 0; i < FILES; i += 10) w.vault.write(paths[i] as string, `local edit ${i}`);
	for (let i = 5; i < FILES; i += 10) w.remote.putFile(paths[i] as string, `remote edit ${i}`);
	for (let i = 1; i < FILES; i += 100) w.vault.remove(paths[i] as string);
	for (let i = 2; i < FILES; i += 100) w.remote.remove(paths[i] as string);
	for (let i = 3; i < FILES; i += 100) w.remote.rename(paths[i] as string, `renamed/${i}.md`);
	for (let i = 0; i < 100; i++) w.vault.write(`new/${i}.md`, `new ${i}`);
	const busy = timed(w, await w.vault.scan());
	t.diagnostic(`busy day: ${busy.ms.toFixed(1)} ms, ${busy.result.ops.length} ops (${counts(busy.result).map(([k, v]) => `${k} ${v}`).join(", ")})`);
	assert.ok(busy.result.ops.some((o) => o.kind === "upload-replace"));
	assert.ok(busy.result.ops.some((o) => o.kind === "download"));
	assert.ok(busy.result.ops.some((o) => o.kind === "local-move"));

	for (const [name, r] of [["first", first], ["steady", steady], ["busy", busy]] as const) {
		assert.ok(r.ms < LIMIT_MS, `${name}: ${r.ms.toFixed(0)} ms is over ${LIMIT_MS} ms`);
	}
});
