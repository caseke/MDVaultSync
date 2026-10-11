#!/usr/bin/env bash
# Backstop for R-NET-1 (ESLint is the primary check): fail if src/ (or the directory given as $1) uses fetch, XMLHttpRequest or WebSocket.
# Lines shaped like a method signature, `fetch(...): Promise<...>`, are skipped: that is RemoteContent.fetch in
# src/core/ports.ts (design §2), and a real call can't be followed by a `: Type` annotation.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
dir="${1:-src}"

hits="$(grep -rnE '(^|[^.[:alnum:]_$])((window|globalThis|self)\.)?fetch[[:space:]]*\(|XMLHttpRequest|WebSocket' "$dir" \
	| grep -vE ':[0-9]+:[[:space:]]*fetch\(.*\)[[:space:]]*:[[:space:]]*Promise<' || true)"
if [ -n "$hits" ]; then
	echo "Forbidden network API in $dir (R-NET-1). Use HttpTransport:" >&2
	echo "$hits" >&2
	exit 1
fi
echo "no forbidden network APIs"
