import { copyFileSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";

const DEST =
	"C:/Users/PedroFerreira/OneDrive - Roboyo Global/Documents/ROBOYO_VAULT/.obsidian/plugins/sync-projects-md";

// Files that should always be deployed
const FILES = ["main.js", "manifest.json", "styles.css"];

// Also pick up any additional root-level files that Obsidian plugins may need
// (e.g. data.json is managed by Obsidian itself, so we skip it)
const SKIP = new Set(["package.json", "package-lock.json", "tsconfig.json", "node_modules", ".git", ".gitignore", "deploy.mjs", "esbuild.config.mjs", "data.json", "CLAUDE.md"]);

const SRC = process.cwd();

// Ensure destination exists
mkdirSync(DEST, { recursive: true });

// Collect files to copy: start with the explicit list, then add any other
// root-level files that aren't in SKIP and aren't directories/source folders
const toCopy = new Set(FILES);

for (const entry of readdirSync(SRC, { withFileTypes: true })) {
	if (entry.isFile() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
		toCopy.add(entry.name);
	}
}

let copied = 0;
for (const file of toCopy) {
	try {
		copyFileSync(join(SRC, file), join(DEST, file));
		console.log(`  ✓ ${file}`);
		copied++;
	} catch (err) {
		if (err.code === "ENOENT") {
			// File doesn't exist in source (e.g. styles.css not yet created) — skip silently
		} else {
			console.error(`  ✗ ${file}: ${err.message}`);
		}
	}
}

console.log(`\nDeployed ${copied} file(s) → ${DEST}`);
