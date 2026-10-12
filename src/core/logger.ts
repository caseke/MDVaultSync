// Redacting typed logger (design §9, R-SEC-3, T-I3). The only string a caller can pass is `code`, and it is
// filtered to a short identifier, so paths, names, contents and tokens can't reach the log.
import type { OpKind } from "./ports.ts";

export interface LogFields {
	count?: number;
	durationMs?: number;
	status?: number;
	code?: string;
	attempt?: number;
}
export interface LogEntry extends LogFields {
	t: number;
	op: OpKind;
}
export interface Logger {
	event(op: OpKind, fields?: LogFields): void;
}

export const LOG_CAPACITY = 500;
export const LOG_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Shape of every OpKind ("graph.request", "op.upload-new", ...); anything else is dropped. */
const OP_RE = /^[a-z]+\.[a-z-]{1,32}$/;
const NUMERIC_FIELDS = ["count", "durationMs", "status", "attempt"] as const;

export const NULL_LOGGER: Logger = { event: () => {} };

export interface RingLoggerOptions {
	now: () => number;
	capacity?: number;
	/** When it returns true, events are mirrored to console.debug ("Verbose logging"). */
	debug?: () => boolean;
}

export class RingLogger implements Logger {
	private readonly buf: LogEntry[] = [];
	private readonly now: () => number;
	private readonly capacity: number;
	private readonly debug: () => boolean;

	constructor(opts: RingLoggerOptions) {
		this.now = opts.now;
		this.capacity = opts.capacity ?? LOG_CAPACITY;
		this.debug = opts.debug ?? (() => false);
	}

	event(op: OpKind, fields: LogFields = {}): void {
		if (typeof op !== "string" || !OP_RE.test(op)) return;
		// Copy known fields only: extra keys smuggled in at runtime are ignored.
		const entry: LogEntry = { t: this.now(), op };
		for (const k of NUMERIC_FIELDS) {
			const v: unknown = fields[k];
			if (typeof v === "number" && Number.isFinite(v)) entry[k] = v;
		}
		if (fields.code !== undefined) {
			entry.code = typeof fields.code === "string" && LOG_CODE_RE.test(fields.code) ? fields.code : "other";
		}
		this.buf.push(entry);
		if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
		if (this.debug()) console.debug(`MDVaultSync ${JSON.stringify(entry)}`);
	}

	entries(): LogEntry[] {
		return this.buf.map((e) => ({ ...e }));
	}

	/** JSON lines, for "Copy log" in diagnostics. */
	serialize(): string {
		return this.buf.map((e) => JSON.stringify(e)).join("\n");
	}

	clear(): void {
		this.buf.length = 0;
	}
}
