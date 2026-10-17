// Supply-chain checks on the GitHub workflows (T-E4, T-T7). Plain text checks, so no YAML dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const DIR = ".github/workflows";
const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
const read = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");
const release = read("release.yml");

/** Lines of the block that starts at `header` (exact line) and is indented deeper than it. */
function block(text: string, header: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf(header);
	assert.ok(start >= 0, `missing block ${JSON.stringify(header)}`);
	const indent = header.length - header.trimStart().length;
	const out: string[] = [];
	for (const l of lines.slice(start + 1)) {
		if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
		if (l.length - l.trimStart().length <= indent) break;
		out.push(l.trim());
	}
	return out;
}

/** The steps of a job, each as its raw text. */
function steps(job: string): string[] {
	return block(release, `  ${job}:`)
		.join("\n")
		.split(/\n(?=- )/)
		.filter((s) => s.startsWith("- "));
}

test("every action is pinned to a full commit SHA with a version comment", () => {
	for (const f of files) {
		for (const line of read(f).split("\n")) {
			const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
			if (!m) continue;
			assert.match(m[1] ?? "", /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${line.trim()}`);
			assert.match(m[2] ?? "", /#\s*v\d/, `${f}: missing version comment: ${line.trim()}`);
		}
	}
});

test("no workflow uses pull_request_target", () => {
	for (const f of files) assert.ok(!read(f).includes("pull_request_target"), f);
});

test("every checkout drops credentials", () => {
	for (const f of files) {
		const parts = read(f).split(/uses: actions\/checkout@/).slice(1);
		for (const p of parts) assert.match(p.split(/\n\s*- /)[0] ?? "", /persist-credentials: false/, f);
	}
});

test("no ${{ }} expression inside a run: script in any workflow", () => {
	for (const f of files) {
		const lines = read(f).split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = /^(\s*)(?:- )?run:(.*)$/.exec(lines[i] ?? "");
			if (!m) continue;
			const indent = (m[1] ?? "").length;
			const script = [m[2] ?? ""];
			for (let j = i + 1; j < lines.length; j++) {
				const l = lines[j] ?? "";
				if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
				script.push(l);
			}
			assert.ok(!script.join("\n").includes("${{"), `${f}:${i + 1} expression inside run:`);
		}
	}
});

test("release.yml triggers only on exact x.y.z tags", () => {
	assert.deepEqual(block(release, "on:"), ["push:", "tags:", '- "[0-9]+.[0-9]+.[0-9]+"']);
});

test("release.yml permissions: read-only default, read-only build, three write scopes on release only", () => {
	assert.deepEqual(block(release, "permissions:"), ["contents: read"]);
	const jobsAt = release.split("\n").indexOf("jobs:");
	const jobNames = release.split("\n").slice(jobsAt + 1).filter((l) => /^ {2}[\w-]+:$/.test(l)).map((l) => l.trim());
	assert.deepEqual(jobNames, ["build:", "release:"]);
	const perms = (job: string) => {
		const lines = block(release, `  ${job}:`);
		const i = lines.indexOf("permissions:");
		assert.ok(i >= 0, `${job} has no permissions block`);
		const out: string[] = [];
		for (const l of lines.slice(i + 1)) {
			if (!/^[\w-]+: \w+$/.test(l)) break;
			out.push(l);
		}
		return out.sort();
	};
	assert.deepEqual(perms("build"), ["contents: read"]);
	assert.deepEqual(perms("release"), ["attestations: write", "contents: write", "id-token: write"]);
});

test("the release job runs no repository or npm code", () => {
	const job = block(release, "  release:").join("\n");
	assert.ok(!job.includes("actions/checkout"), "no checkout in the release job");
	assert.ok(!/\bnpm\b|\bnode\b|scripts\//.test(job), "no npm, node or repo scripts in the release job");
	assert.match(job, /needs: build/);
});

test("the tag-equals-manifest check is a real step that runs before npm ci", () => {
	const s = steps("build");
	const i = s.findIndex((x) => x.includes("name: Tag must equal the manifest version"));
	const npm = s.findIndex((x) => x.includes("run: npm ci"));
	assert.ok(i >= 0 && npm > i, "check step exists and precedes npm ci");
	const step = s[i] ?? "";
	assert.match(step, /TAG: \$\{\{ github\.ref_name \}\}/);
	assert.match(step, /require\("\.\/manifest\.json"\)\.version/);
	assert.match(step, /if \[ "\$TAG" != "\$version" \]; then/);
	assert.match(step, /exit 1/);
});

test("the release job re-checks the tag, attests, and creates only a draft", () => {
	const s = steps("release");
	const moved = s.findIndex((x) => x.includes("name: Tag must still point at the built commit"));
	const attest = s.findIndex((x) => x.includes("uses: actions/attest@"));
	const create = s.findIndex((x) => x.includes("gh release create"));
	assert.ok(moved >= 0 && attest > moved && create > attest, "order: tag re-check, attest, create");
	assert.match(s[moved] ?? "", /if \[ "\$tagged" != "\$GITHUB_SHA" \]; then/);
	for (const f of ["main.js", "manifest.json", "styles.css"]) assert.ok((s[attest] ?? "").includes(f), `attests ${f}`);
	const createLine = (s[create] ?? "").split("\n").filter((l) => l.includes("gh release create") || l.includes("flags="));
	assert.ok(createLine.some((l) => l.includes('flags="--draft"')), "draft flag");
	assert.ok(createLine.some((l) => l.includes("$flags")), "flags used by gh release create");
});

test("only 0.x tags are pre-releases, so 1.0.0 and later are full (draft) releases BRAT installs as latest [O-BRAT-1]", () => {
	const create = steps("release").find((x) => x.includes("gh release create")) ?? "";
	const cases = create.split("\n").filter((l) => l.includes("case "));
	assert.deepEqual(cases, ['case "$TAG" in 0.*) flags="$flags --prerelease" ;; esac']);
	assert.equal((create.match(/--prerelease/g) ?? []).length, 1);
});

test("gh release create refuses a tag that doesn't exist on GitHub (--verify-tag)", () => {
	const create = steps("release").find((x) => x.includes("gh release create")) ?? "";
	assert.match(create, /gh release create "\$TAG" \$flags .*--verify-tag/);
});

test("the release job refuses a tag on a commit that isn't on main, before attesting (T-T8)", () => {
	const s = steps("release");
	const onMain = s.findIndex((x) => x.includes("name: Tagged commit must be on main"));
	const attest = s.findIndex((x) => x.includes("uses: actions/attest@"));
	assert.ok(onMain >= 0 && attest > onMain, "main check exists and precedes attest");
	const step = s[onMain] ?? "";
	assert.match(step, /base="\$\(gh api "repos\/\$GH_REPO\/branches\/main" --jq \.commit\.sha\)"/);
	assert.match(step, /gh api "repos\/\$GH_REPO\/compare\/\$base\.\.\.\$GITHUB_SHA" --jq \.status/);
	assert.match(step, /if \[ "\$status" != "behind" \] && \[ "\$status" != "identical" \]; then/);
	assert.match(step, /exit 1/);
});
