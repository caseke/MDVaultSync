// The platform this copy runs on, for the default device name (design §11).
import { Platform } from "obsidian";

export function platformName(): string {
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isLinux) return "linux";
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	return "other";
}
