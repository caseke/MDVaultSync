// The run-diagnostics command (plan M3): runs the Graph capability probe and shows its JSON. The probe itself is
// in src/remote/probe.ts, because RemotePort content calls are allowed only there (R-ENG-4 lint rule) and it
// can be unit tested without Obsidian.
import { Notice, Platform } from "obsidian";
import type { App } from "obsidian";
import { runProbe, type ProbeDeps } from "../remote/probe.ts";
import { DiagnosticsModal } from "../ui/diagnostics-modal.ts";

export function platformName(): string {
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isLinux) return "linux";
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	return "other";
}

export class Diagnostics {
	private running = false;
	private readonly app: App;
	private readonly deps: () => Omit<ProbeDeps, "platform">;
	private readonly isSignedIn: () => boolean;
	private readonly resetBudget: () => void;

	constructor(app: App, deps: () => Omit<ProbeDeps, "platform">, isSignedIn: () => boolean, resetBudget: () => void) {
		this.app = app;
		this.deps = deps;
		this.isSignedIn = isSignedIn;
		this.resetBudget = resetBudget;
	}

	async run(): Promise<void> {
		if (!this.isSignedIn()) {
			new Notice("Sign in to OneDrive before running the probe.");
			return;
		}
		if (this.running) {
			new Notice("The probe is already running.");
			return;
		}
		this.running = true;
		// Each probe is its own run for the retry budget (design §6.1); M6 resets it per sync run.
		this.resetBudget();
		const modal = new DiagnosticsModal(this.app);
		modal.open();
		try {
			const result = await runProbe({ ...this.deps(), platform: platformName() });
			modal.showResult(JSON.stringify(result, null, 2));
		} catch (e) {
			// runProbe catches its own failures; this is a bug guard. Name only, never the message (T-I3).
			console.error(`MDVaultSync: probe failed (${e instanceof Error ? e.name : "unknown"})`);
			modal.close();
			new Notice("The probe failed unexpectedly.");
		} finally {
			this.running = false;
		}
	}
}
