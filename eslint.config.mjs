import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";
// Node ≥ 22.18 strips the types of this .ts import natively [C-NODE-1].
import { projectRules, restrictedDisables } from "./eslint/project-rules.ts";

// obsidianmd's own list of rules that may not be disabled inline. Flat config replaces rule options, so the
// src/ block below restates this list plus ours instead of dropping it.
const obsidianRestrictedDisables = obsidianmd.configs.recommended
	.map((c) => c.rules?.["eslint-comments/no-restricted-disable"])
	.filter(Array.isArray)
	.flatMap((entry) => entry.slice(1));
if (obsidianRestrictedDisables.length === 0) {
	throw new Error("eslint-plugin-obsidianmd no longer sets eslint-comments/no-restricted-disable; review eslint.config.mjs");
}

export default defineConfig(
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.mjs",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ["manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Tests and lint config run on Node only and never ship in main.js.
		files: ["test/**/*.ts", "eslint/**/*.ts"],
		languageOptions: { globals: { ...globals.node } },
		rules: {
			"obsidianmd/no-nodejs-modules": "off",
			// Fixtures use the default configDir name on purpose: proving it is excluded is the test (M7).
			"obsidianmd/hardcoded-config-path": "off",
			"@typescript-eslint/no-floating-promises": [
				"error",
				{
					allowForKnownSafeCalls: [
						{ from: "package", package: "node:test", name: ["test", "it", "describe", "suite"] },
					],
				},
			],
		},
	},
	...projectRules,
	{
		files: ["src/**/*.ts"],
		rules: {
			"eslint-comments/no-restricted-disable": [
				"error",
				...new Set([...obsidianRestrictedDisables, ...restrictedDisables]),
			],
		},
	},
);
