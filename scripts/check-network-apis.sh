#!/usr/bin/env bash
# Backstop for R-NET-1 (ESLint is the primary check): fail if src/ (or the directory given as $1) uses fetch, XMLHttpRequest or WebSocket.
# Two exemptions, both the RemoteContent.fetch method (design §2): its signature in core/ports.ts and its
# implementation's declaration line in core/remote-content.ts (M6). Each is anchored to that file and that exact line shape.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
dir="${1:-src}"

hits="$(grep -rnE '(^|[^.[:alnum:]_$])(([[:alnum:]_$]*[Ww]indow|globalThis|self)\.)?fetch[[:space:]]*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon' "$dir" \
	| grep -vE "^${dir%/}/core/ports\.ts:[0-9]+:[[:space:]]*fetch\(item: RemoteItem, path: VaultPath\): Promise<" \
	| grep -vE "^${dir%/}/core/remote-content\.ts:[0-9]+:[[:space:]]*async fetch\(item: RemoteItem, path: VaultPath\): Promise<" || true)"
if [ -n "$hits" ]; then
	echo "Forbidden network API in $dir (R-NET-1). Use HttpTransport:" >&2
	echo "$hits" >&2
	exit 1
fi
echo "no forbidden network APIs"
