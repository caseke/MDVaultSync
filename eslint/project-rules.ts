// Project lint rules (docs/plan.md M1). Loaded by eslint.config.mjs through Node's type stripping [C-NODE-1],
// and exercised directly by test/lint-rules.test.ts.
// Flat config replaces a rule's options per matching block, so scoped blocks restate the shared entries.
import type { Linter } from "eslint";

const SRC = ["src/**/*.ts"];

// R-NET-1: no Node networking, processes or file system in shipped code. `obsidian` is added for core/remote.
const nodeModuleBans = ["http", "https", "net", "child_process", "fs"].flatMap((name) => [
	{ name, message: "Node built-ins are not available on mobile and bypass requestUrl (R-NET-1)." },
	{ name: `node:${name}`, message: "Node built-ins are not available on mobile and bypass requestUrl (R-NET-1)." },
]);
const nodePatternBans = [{ group: ["fs/*", "node:fs/*"], message: "No direct file system access; use the Vault API." }];
const obsidianBan = { name: "obsidian", message: "src/core and src/remote must not import obsidian (R-ENG-3)." };

// T-E3: no remote or dynamic code loading.
const dynamicImportBan = {
	selector: "ImportExpression",
	message: "Dynamic import() is not allowed (T-E3, [O-POL-3]).",
};
// R-ENG-4: file bytes move only through RemoteContent (src/core/remote-content.ts).
const contentMethodBan = {
	selector:
		"CallExpression > MemberExpression.callee[property.name=/^(download|uploadNew|uploadReplace|createUploadSession|putFragment)$/]",
	message: "Call RemotePort content methods only from src/core/remote-content.ts (R-ENG-4).",
};

export const projectRules: Linter.Config[] = [
	{
		name: "mdvaultsync/src",
		files: SRC,
		rules: {
			"no-restricted-imports": ["error", { paths: nodeModuleBans, patterns: nodePatternBans }],
			"no-restricted-globals": [
				"error",
				{ name: "fetch", message: "Use HttpTransport (requestUrl) (R-NET-1)." },
				{ name: "XMLHttpRequest", message: "Use HttpTransport (requestUrl) (R-NET-1)." },
				{ name: "WebSocket", message: "No WebSocket (R-NET-1)." },
			],
			"no-restricted-properties": [
				"error",
				{ object: "window", property: "fetch", message: "Use HttpTransport (requestUrl) (R-NET-1)." },
				{ object: "globalThis", property: "fetch", message: "Use HttpTransport (requestUrl) (R-NET-1)." },
				{ object: "self", property: "fetch", message: "Use HttpTransport (requestUrl) (R-NET-1)." },
			],
			"no-restricted-syntax": ["error", dynamicImportBan, contentMethodBan],
			"no-eval": "error",
			"no-implied-eval": "error",
			"no-new-func": "error",
		},
	},
	{
		name: "mdvaultsync/core-remote",
		files: ["src/core/**/*.ts", "src/remote/**/*.ts"],
		rules: {
			"no-restricted-imports": ["error", { paths: [...nodeModuleBans, obsidianBan], patterns: nodePatternBans }],
		},
	},
	{
		name: "mdvaultsync/content-owners",
		files: ["src/core/remote-content.ts", "src/remote/**/*.ts"],
		rules: {
			"no-restricted-syntax": ["error", dynamicImportBan],
		},
	},
];
