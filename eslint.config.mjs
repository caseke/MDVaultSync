import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";
// Node ≥ 22.18 strips the types of this .ts import natively [C-NODE-1].
import { projectRules } from "./eslint/project-rules.ts";

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
);
