#!/usr/bin/env bash
# PostToolUse hook (docs/plan.md M1): lint and typecheck a TypeScript file Claude just edited.
# Input: the hook event as JSON on stdin (tool_input.file_path), or a path as $1 when run by hand.
# Exit 0 = clean or not applicable (silent). Exit 2 = errors on stderr, which Claude must fix.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root" || exit 0

if [ $# -ge 1 ]; then
	file="$1"
else
	# Parse with node so the hook doesn't depend on jq. Bad or empty input yields an empty path.
	file="$(node -e '
		let s = "";
		process.stdin.on("data", (c) => (s += c));
		process.stdin.on("end", () => {
			try { const p = JSON.parse(s)?.tool_input?.file_path; if (typeof p === "string") process.stdout.write(p); } catch {}
		});
	' 2>/dev/null)"
fi

[ -n "$file" ] || exit 0
case "$file" in
	*.ts | *.mts) ;;
	*) exit 0 ;;
esac

abs="$(realpath -m -- "$file")"
case "$abs" in
	"$root"/node_modules/* | "$root"/*/node_modules/*) exit 0 ;;
	"$root"/*) ;;
	*) exit 0 ;;
esac
[ -f "$abs" ] || exit 0

if [ ! -d node_modules ]; then
	echo "check.sh: node_modules is missing; run npm ci to enable lint and typecheck on edit." >&2
	exit 0
fi

rel="${abs#"$root"/}"
status=0
if ! out="$(npx --no-install eslint --max-warnings=0 -- "$rel" 2>&1)"; then
	printf 'eslint failed for %s:\n%s\n' "$rel" "$out" >&2
	status=2
fi
if ! out="$(npx --no-install tsc --noEmit 2>&1)"; then
	printf 'tsc --noEmit failed:\n%s\n' "$out" >&2
	status=2
fi
exit "$status"
