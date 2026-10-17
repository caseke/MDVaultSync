// Copying text to the clipboard so that the caller always gets an answer (M9 owner note: on Ubuntu, Copy log did
// nothing and showed no notice, so the clipboard call either threw before its promise existed or never settled).
// Pure, so it runs under node --test; the log modal falls back to selecting the text on "manual".

/** The subset of `navigator.clipboard` used here. */
export interface ClipboardLike {
	writeText(text: string): Promise<void>;
}

/** Starts a timer and returns its cancel function. */
export type SetTimer = (ms: number, fn: () => void) => () => void;

/** How long a clipboard write may take before the user is asked to copy by hand. */
export const COPY_TIMEOUT_MS = 2_000;

export async function copyText(text: string, clipboard: ClipboardLike | undefined, setTimer: SetTimer): Promise<"copied" | "manual"> {
	if (typeof clipboard?.writeText !== "function") return "manual";
	let write: Promise<void>;
	try {
		const r: unknown = clipboard.writeText(text);
		// Not the standard API: nothing says it copied, so ask the user to copy by hand.
		if (typeof (r as { then?: unknown } | null | undefined)?.then !== "function") return "manual";
		write = r as Promise<void>;
	} catch {
		return "manual";
	}
	let cancel: () => void = () => undefined;
	const timedOut = new Promise<"manual">((resolve) => {
		cancel = setTimer(COPY_TIMEOUT_MS, () => resolve("manual"));
	});
	const wrote = write.then(
		() => "copied" as const,
		() => "manual" as const,
	);
	try {
		return await Promise.race([wrote, timedOut]);
	} finally {
		cancel();
	}
}
