import { Vault, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { FileEntry, PluginSettings, SyncResult, OnProgress } from "./types";

const IGNORED_DIRS = new Set([
	".git",
	".svn",
	".hg",
	"node_modules",
	".obsidian",
	"__pycache__",
	".venv",
	"venv",
	".env",
	"dist",
	"build",
	".next",
	".nuxt",
	".cache",
	".DS_Store",
]);

const COPY_BATCH_SIZE = 5;
const SCAN_CONCURRENCY = 10;

interface ScanOutput {
	files: FileEntry[];
	skippedDetails: string[];
}

export class SyncEngine {
	private vault: Vault;
	private settings: PluginSettings;
	private destCache: Map<string, number> = new Map();
	private cacheBuilt = false;

	constructor(vault: Vault, settings: PluginSettings) {
		this.vault = vault;
		this.settings = settings;
	}

	updateSettings(settings: PluginSettings): void {
		this.settings = settings;
	}

	invalidateCache(): void {
		this.cacheBuilt = false;
		this.destCache.clear();
	}

	private get destPrefix(): string {
		return `1_PROJECTS/${this.settings.destFolderName}`;
	}

	/** List top-level project directories from sourcePath */
	async listProjects(): Promise<string[]> {
		try {
			const dirents = await fs.promises.readdir(this.settings.sourcePath, {
				withFileTypes: true,
			});
			const projects: string[] = [];
			for (const dirent of dirents) {
				if (dirent.name.startsWith(".") || IGNORED_DIRS.has(dirent.name)) continue;
				if (dirent.isDirectory()) {
					projects.push(dirent.name);
				} else if (dirent.isSymbolicLink()) {
					try {
						const fullPath = path.join(this.settings.sourcePath, dirent.name);
						const stat = await fs.promises.stat(fullPath);
						if (stat.isDirectory()) {
							projects.push(dirent.name);
						}
					} catch {
						// Skip broken symlinks
					}
				}
			}
			return projects.sort();
		} catch {
			return [];
		}
	}

	async sync(signal?: AbortSignal, onProgress?: OnProgress): Promise<SyncResult> {
		const start = Date.now();
		const result: SyncResult = {
			copied: 0,
			deleted: 0,
			skipped: 0,
			errors: 0,
			elapsedMs: 0,
			details: [],
		};

		// 1. Validate source path
		try {
			await fs.promises.access(this.settings.sourcePath, fs.constants.R_OK);
		} catch {
			throw new Error(`Source path not accessible: ${this.settings.sourcePath}`);
		}

		if (signal?.aborted) return result;

		// 2. Scan source for .md files
		const scanOutput = await this.scanSource(signal);
		if (signal?.aborted) return result;

		const sourceFiles = scanOutput.files;
		result.skipped = scanOutput.skippedDetails.length;
		result.details.push(...scanOutput.skippedDetails);

		// 3. Build dest cache on first run
		if (!this.cacheBuilt) {
			this.buildDestCache();
			this.cacheBuilt = true;
		}

		// 4. Diff — find files to copy
		const toCopy: FileEntry[] = [];
		const sourceRelPaths = new Set<string>();

		for (const entry of sourceFiles) {
			sourceRelPaths.add(entry.relativePath);
			const cachedMtime = this.destCache.get(entry.relativePath);
			if (cachedMtime === undefined || entry.mtimeMs > cachedMtime) {
				toCopy.push(entry);
			}
		}

		// 5. Copy in batches
		for (let i = 0; i < toCopy.length; i += COPY_BATCH_SIZE) {
			if (signal?.aborted) return result;
			const batch = toCopy.slice(i, i + COPY_BATCH_SIZE);
			const createdFolders = new Set<string>();

			await Promise.all(
				batch.map(async (entry) => {
					try {
						await this.copyFile(entry, createdFolders);
						this.destCache.set(entry.relativePath, Date.now());
						result.copied++;
						result.details.push(`Copied: ${entry.relativePath}`);
					} catch (e) {
						result.errors++;
						result.details.push(`Error copying ${entry.relativePath}: ${e}`);
					}
				})
			);

			if (onProgress) {
				onProgress(result.copied + result.errors, toCopy.length);
			}

			// Yield to event loop between batches
			if (i + COPY_BATCH_SIZE < toCopy.length) {
				await sleep(0);
			}
		}

		// 6. Orphan deletion
		if (this.settings.deleteOrphans) {
			for (const [relPath] of this.destCache) {
				if (signal?.aborted) return result;
				if (!sourceRelPaths.has(relPath)) {
					try {
						const vaultPath = `${this.destPrefix}/${relPath}`;
						const file = this.vault.getAbstractFileByPath(vaultPath);
						if (file instanceof TFile) {
							await this.vault.delete(file);
							this.destCache.delete(relPath);
							result.deleted++;
							result.details.push(`Deleted orphan: ${relPath}`);
						}
					} catch (e) {
						result.errors++;
						result.details.push(`Error deleting ${relPath}: ${e}`);
					}
				}
			}
		}

		result.elapsedMs = Date.now() - start;

		// 7. Write sync log
		await this.writeLog(result);

		return result;
	}

	private async scanSource(signal?: AbortSignal): Promise<ScanOutput> {
		const files: FileEntry[] = [];
		const skippedDetails: string[] = [];

		// Read top-level directories and apply project filter
		let topLevelDirs: string[];
		try {
			const dirents = await fs.promises.readdir(this.settings.sourcePath, {
				withFileTypes: true,
			});
			topLevelDirs = [];
			for (const dirent of dirents) {
				if (dirent.name.startsWith(".") || IGNORED_DIRS.has(dirent.name)) continue;

				const fullPath = path.join(this.settings.sourcePath, dirent.name);
				let isDir = dirent.isDirectory();

				// Handle symlinks
				if (dirent.isSymbolicLink()) {
					if (this.settings.skipSymlinks) continue;
					try {
						const stat = await fs.promises.stat(fullPath);
						isDir = stat.isDirectory();
					} catch {
						continue; // Broken symlink
					}
				}

				if (isDir) {
					// Apply project filter
					if (
						this.settings.includedProjects.length > 0 &&
						!this.settings.includedProjects.includes(dirent.name)
					) {
						continue;
					}
					topLevelDirs.push(fullPath);
				} else if (dirent.isFile() && dirent.name.endsWith(".md")) {
					const relativePath = dirent.name;
					if (!this.isExcluded(relativePath)) {
						try {
							const stat = await fs.promises.stat(fullPath);
							if (stat.size > this.settings.maxFileSizeKB * 1024) {
								const sizeKB = Math.round(stat.size / 1024);
								skippedDetails.push(`Skipped (too large): ${relativePath} (${sizeKB} KB)`);
							} else {
								files.push({ relativePath, mtimeMs: stat.mtimeMs });
							}
						} catch {
							// Skip unreadable files
						}
					}
				}
			}
		} catch {
			return { files, skippedDetails };
		}

		// Scan each top-level project directory
		const queue: string[] = [...topLevelDirs];

		while (queue.length > 0) {
			if (signal?.aborted) return { files, skippedDetails };

			const batch = queue.splice(0, SCAN_CONCURRENCY);
			const batchResults = await Promise.all(
				batch.map(async (dir) => {
					try {
						return await this.scanDir(dir, skippedDetails);
					} catch {
						return { subdirs: [], files: [] };
					}
				})
			);

			for (const { subdirs, files: batchFiles } of batchResults) {
				queue.push(...subdirs);
				files.push(...batchFiles);
			}
		}

		return { files, skippedDetails };
	}

	private isExcluded(relativePath: string): boolean {
		const segments = relativePath.split("/");
		for (const pattern of this.settings.excludePatterns) {
			if (!pattern) continue;
			// Match any path segment exactly, or match as a path prefix
			if (segments.some((seg) => seg === pattern)) return true;
			if (relativePath.startsWith(pattern + "/")) return true;
		}
		return false;
	}

	private async scanDir(
		dirPath: string,
		skippedDetails: string[]
	): Promise<{ subdirs: string[]; files: FileEntry[] }> {
		const subdirs: string[] = [];
		const files: FileEntry[] = [];

		const dirents = await fs.promises.readdir(dirPath, {
			withFileTypes: true,
		});

		const statPromises: Promise<void>[] = [];

		for (const dirent of dirents) {
			const name = dirent.name;

			// Skip hidden files/dirs and ignored directories
			if (name.startsWith(".") || IGNORED_DIRS.has(name)) continue;

			const fullPath = path.join(dirPath, name);
			const relativePath = path.relative(this.settings.sourcePath, fullPath);

			// Handle symlinks
			if (dirent.isSymbolicLink()) {
				if (this.settings.skipSymlinks) continue;
				try {
					const stat = await fs.promises.stat(fullPath);
					if (stat.isDirectory()) {
						if (!this.isExcluded(relativePath)) {
							subdirs.push(fullPath);
						}
					} else if (stat.isFile() && name.endsWith(".md")) {
						if (!this.isExcluded(relativePath)) {
							if (stat.size > this.settings.maxFileSizeKB * 1024) {
								const sizeKB = Math.round(stat.size / 1024);
								skippedDetails.push(`Skipped (too large): ${relativePath} (${sizeKB} KB)`);
							} else {
								files.push({ relativePath, mtimeMs: stat.mtimeMs });
							}
						}
					}
				} catch {
					// Broken symlink — skip
				}
				continue;
			}

			// Check exclude patterns
			if (this.isExcluded(relativePath)) continue;

			if (dirent.isDirectory()) {
				subdirs.push(fullPath);
			} else if (dirent.isFile() && name.endsWith(".md")) {
				statPromises.push(
					fs.promises.stat(fullPath).then((stat) => {
						if (stat.size > this.settings.maxFileSizeKB * 1024) {
							const sizeKB = Math.round(stat.size / 1024);
							skippedDetails.push(`Skipped (too large): ${relativePath} (${sizeKB} KB)`);
							return;
						}
						files.push({
							relativePath,
							mtimeMs: stat.mtimeMs,
						});
					})
				);
			}
		}

		await Promise.all(statPromises);
		return { subdirs, files };
	}

	private buildDestCache(): void {
		this.destCache.clear();
		const prefix = this.destPrefix + "/";
		const allFiles = this.vault.getFiles();

		for (const file of allFiles) {
			if (file.path.startsWith(prefix) && file.path.endsWith(".md")) {
				const relativePath = file.path.slice(prefix.length);
				this.destCache.set(relativePath, file.stat.mtime);
			}
		}
	}

	private async copyFile(
		entry: FileEntry,
		createdFolders: Set<string>
	): Promise<void> {
		const sourceFull = path.join(
			this.settings.sourcePath,
			entry.relativePath
		);
		const vaultPath = `${this.destPrefix}/${entry.relativePath}`;

		// Ensure parent folders exist in vault
		const parts = vaultPath.split("/");
		for (let i = 1; i < parts.length; i++) {
			const folderPath = parts.slice(0, i).join("/");
			if (!createdFolders.has(folderPath)) {
				createdFolders.add(folderPath);
				if (!this.vault.getAbstractFileByPath(folderPath)) {
					try {
						await this.vault.createFolder(folderPath);
					} catch {
						// Folder may already exist — race condition is fine
					}
				}
			}
		}

		// Read source file with Node fs
		const content = await fs.promises.readFile(sourceFull, "utf-8");

		// Write into vault using Vault API
		const existing = this.vault.getAbstractFileByPath(vaultPath);
		if (existing instanceof TFile) {
			await this.vault.modify(existing, content);
		} else {
			await this.vault.create(vaultPath, content);
		}
	}

	private async writeLog(result: SyncResult): Promise<void> {
		if (!this.settings.syncLogEnabled) return;
		if (result.copied === 0 && result.deleted === 0 && result.errors === 0) return;

		const now = new Date();
		const timestamp = now.toISOString().replace("T", " ").slice(0, 19);

		let entry = `## ${timestamp}\n`;
		entry += `- Copied: ${result.copied}\n`;
		entry += `- Deleted: ${result.deleted}\n`;
		entry += `- Skipped: ${result.skipped}\n`;
		entry += `- Errors: ${result.errors}\n`;
		entry += `- Duration: ${result.elapsedMs}ms\n`;

		if (result.details.length > 0) {
			entry += `\n<details>\n<summary>Details</summary>\n\n`;
			for (const d of result.details) {
				entry += `- ${d}\n`;
			}
			entry += `\n</details>\n`;
		}

		entry += "\n";

		const logPath = `${this.destPrefix}/sync-log.md`;

		try {
			const existing = this.vault.getAbstractFileByPath(logPath);
			if (existing instanceof TFile) {
				const content = await this.vault.read(existing);
				// Prepend new entry after the header so newest is first
				const firstEntry = content.indexOf("\n## ");
				if (firstEntry >= 0) {
					const before = content.slice(0, firstEntry + 1);
					const after = content.slice(firstEntry + 1);
					await this.vault.modify(existing, before + entry + after);
				} else {
					await this.vault.modify(existing, content + entry);
				}
			} else {
				const header = `---\ntags: [sync-log]\n---\n# Sync Log\n\n`;
				await this.vault.create(logPath, header + entry);
			}
		} catch {
			// Log writing is best-effort — don't fail the sync
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
