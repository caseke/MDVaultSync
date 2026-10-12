// Base for the modals the engine waits on (preview, delete confirmation). The answer resolves exactly once:
// closing the modal any other way is "no" (design §5.4), and the modal closes itself after the engine's own
// 10-minute timeout, so a late tap can't seem to act on a run that has already moved on.
import { Modal } from "obsidian";
import type { App } from "obsidian";
import { PROMPT_TIMEOUT_MS } from "../core/engine.ts";

export abstract class PromptModal extends Modal {
	private resolveFn: ((v: boolean) => void) | null = null;
	private timer: number | null = null;
	readonly answer: Promise<boolean>;

	constructor(app: App) {
		super(app);
		this.answer = new Promise<boolean>((r) => {
			this.resolveFn = r;
		});
	}

	override onOpen(): void {
		this.timer = window.setTimeout(() => this.close(), PROMPT_TIMEOUT_MS);
		this.build();
	}

	protected abstract build(): void;

	protected decide(v: boolean): void {
		this.resolveFn?.(v);
		this.resolveFn = null;
		this.close();
	}

	override onClose(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		this.resolveFn?.(false);
		this.resolveFn = null;
		this.contentEl.empty();
	}
}
