import { Vault, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import {
	FileEntry,
	SkippedEntry,
	PluginSettings,
	SyncResult,
	DryRunResult,
	DryRunEntry,
	OnProgress,
} from "./types";

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
const CONFLICT_TOLERANCE_MS = 5000;

/** Normalize an OS path to forward slashes (vault format). */
function toVaultPath(p: string): string {
	return p.replace(/\\/g, "/");
}

interface ScanOutput {
	files: FileEntry[];
	skipped: SkippedEntry[];
}

interface SyncPlan {
	toCopy: FileEntry[];
	toDelete: string[];
	conflicts: FileEntry[];
	skipped: SkippedEntry[];
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
		return this.settings.destPath;
	}

	private hasMatchingExtension(filename: string): boolean {
		const lower = filename.toLowerCase();
		return this.settings.syncFileExtensions.some((ext) =>
			lower.endsWith(ext.toLowerCase())
		);
	}

	private isConflict(vaultMtime: number): boolean {
		if (!this.settings.conflictDetection) return false;
		if (this.settings.lastSyncTimestamp === 0) return false;
		return vaultMtime > this.settings.lastSyncTimestamp + CONFLICT_TOLERANCE_MS;
	}

	/** List top-level project directories from sourcePath */
	async listProjects(): Promise<string[]> {
		try {
			const dirents = await fs.promises.readdir(this.settings.sourcePath, {
				withFileTypes: true,
			});
			const projects: string[] = [];
			for (const dirent of dirents) {
				if (dirent.name.startsWith(".") || IGNORED_DIRS.has(dirent.name))
					continue;
				if (dirent.isDirectory()) {
					projects.push(dirent.name);
				} else if (dirent.isSymbolicLink()) {
					try {
						const fullPath = path.join(
							this.settings.sourcePath,
							dirent.name
						);
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

	// ── Dry Run ──────────────────────────────────────────

	async dryRun(): Promise<DryRunResult> {
		if (!this.destPrefix) {
			throw new Error("Destination path is not configured");
		}
		await this.validateSource();

		const plan = await this.preparePlan();
		const entries: DryRunEntry[] = [];

		for (const f of plan.conflicts) {
			entries.push({
				relativePath: f.relativePath,
				action: "conflict",
				reason: "modified in both source and vault",
			});
		}

		for (const f of plan.toCopy) {
			const isNew = !this.destCache.has(f.relativePath);
			entries.push({
				relativePath: f.relativePath,
				action: "copy",
				reason: isNew ? "new file" : "source updated",
			});
		}

		for (const relPath of plan.toDelete) {
			entries.push({
				relativePath: relPath,
				action: "delete",
				reason: "source removed",
			});
		}

		for (const s of plan.skipped) {
			entries.push({
				relativePath: s.relativePath,
				action: "skip",
				reason: s.reason,
			});
		}

		return {
			entries,
			toCopy: plan.toCopy.length,
			toDelete: plan.toDelete.length,
			conflicts: plan.conflicts.length,
			skipped: plan.skipped.length,
		};
	}

	// ── Sync ─────────────────────────────────────────────

	async sync(
		signal?: AbortSignal,
		onProgress?: OnProgress,
		overrideConflicts = false
	): Promise<SyncResult> {
		const start = Date.now();
		const result: SyncResult = {
			copied: 0,
			deleted: 0,
			skipped: 0,
			conflicts: 0,
			errors: 0,
			elapsedMs: 0,
			details: [],
		};

		if (!this.destPrefix) {
			throw new Error("Destination path is not configured");
		}

		await this.validateSource();
		if (signal?.aborted) return result;

		const plan = await this.preparePlan(signal);
		if (signal?.aborted) return result;

		// Skipped
		result.skipped = plan.skipped.length;
		for (const s of plan.skipped) {
			result.details.push(`Skipped: ${s.relativePath} \u2014 ${s.reason}`);
		}

		// Build copy list
		const copyList = [...plan.toCopy];
		if (overrideConflicts) {
			copyList.push(...plan.conflicts);
		} else {
			result.conflicts = plan.conflicts.length;
			for (const f of plan.conflicts) {
				result.details.push(
					`Conflict: ${f.relativePath} \u2014 modified in both source and vault`
				);
			}
		}

		// Copy in batches
		for (let i = 0; i < copyList.length; i += COPY_BATCH_SIZE) {
			if (signal?.aborted) return result;
			const batch = copyList.slice(i, i + COPY_BATCH_SIZE);

			// Pre-create all needed folders sequentially before concurrent copies
			const createdFolders = new Set<string>();
			for (const entry of batch) {
				const vaultPath = `${this.destPrefix}/${entry.relativePath}`;
				const parts = vaultPath.split("/");
				for (let j = 1; j < parts.length; j++) {
					const folderPath = parts.slice(0, j).join("/");
					if (!createdFolders.has(folderPath)) {
						createdFolders.add(folderPath);
						if (!this.vault.getAbstractFileByPath(folderPath)) {
							try {
								await this.vault.createFolder(folderPath);
							} catch {
								// Folder may already exist
							}
						}
					}
				}
			}

			await Promise.all(
				batch.map(async (entry) => {
					try {
						await this.copyFile(entry);
						this.destCache.set(entry.relativePath, Date.now());
						result.copied++;
						result.details.push(`Copied: ${entry.relativePath}`);
					} catch (e) {
						result.errors++;
						result.details.push(
							`Error copying ${entry.relativePath}: ${e}`
						);
					}
				})
			);

			if (onProgress) {
				onProgress(result.copied + result.errors, copyList.length);
			}

			if (i + COPY_BATCH_SIZE < copyList.length) {
				await sleep(0);
			}
		}

		// Delete orphans
		for (const relPath of plan.toDelete) {
			if (signal?.aborted) return result;
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

		result.elapsedMs = Date.now() - start;
		await this.writeLog(result);
		return result;
	}

	// ── Plan ─────────────────────────────────────────────

	private async validateSource(): Promise<void> {
		try {
			await fs.promises.access(
				this.settings.sourcePath,
				fs.constants.R_OK
			);
		} catch {
			throw new Error(
				`Source path not accessible: ${this.settings.sourcePath}`
			);
		}
	}

	private async preparePlan(signal?: AbortSignal): Promise<SyncPlan> {
		const scanOutput = await this.scanSource(signal);

		if (!this.cacheBuilt) {
			this.buildDestCache();
			this.cacheBuilt = true;
		}

		const toCopy: FileEntry[] = [];
		const conflicts: FileEntry[] = [];
		const sourceRelPaths = new Set<string>();

		for (const entry of scanOutput.files) {
			sourceRelPaths.add(entry.relativePath);
			const cachedMtime = this.destCache.get(entry.relativePath);

			if (cachedMtime === undefined) {
				toCopy.push(entry);
			} else if (entry.mtimeMs > cachedMtime) {
				if (this.isConflict(cachedMtime)) {
					conflicts.push(entry);
				} else {
					toCopy.push(entry);
				}
			}
		}

		const toDelete: string[] = [];
		if (this.settings.deleteOrphans) {
			for (const [relPath] of this.destCache) {
				if (relPath === "sync-log.md") continue;
				if (!sourceRelPaths.has(relPath)) {
					toDelete.push(relPath);
				}
			}
		}

		return { toCopy, toDelete, conflicts, skipped: scanOutput.skipped };
	}

	// ── Scan ─────────────────────────────────────────────

	private async scanSource(signal?: AbortSignal): Promise<ScanOutput> {
		const files: FileEntry[] = [];
		const skipped: SkippedEntry[] = [];

		let topLevelDirs: string[];
		try {
			const dirents = await fs.promises.readdir(this.settings.sourcePath, {
				withFileTypes: true,
			});
			topLevelDirs = [];
			for (const dirent of dirents) {
				if (
					dirent.name.startsWith(".") ||
					IGNORED_DIRS.has(dirent.name)
				)
					continue;

				const fullPath = path.join(
					this.settings.sourcePath,
					dirent.name
				);
				let isDir = dirent.isDirectory();

				if (dirent.isSymbolicLink()) {
					if (this.settings.skipSymlinks) continue;
					try {
						const stat = await fs.promises.stat(fullPath);
						isDir = stat.isDirectory();
					} catch {
						continue;
					}
				}

				if (isDir) {
					if (
						this.settings.includedProjects.length > 0 &&
						!this.settings.includedProjects.includes(dirent.name)
					) {
						continue;
					}
					topLevelDirs.push(fullPath);
				} else if (
					dirent.isFile() &&
					this.hasMatchingExtension(dirent.name)
				) {
					const relativePath = dirent.name;
					if (!this.isExcluded(relativePath)) {
						try {
							const stat = await fs.promises.stat(fullPath);
							if (
								stat.size >
								this.settings.maxFileSizeKB * 1024
							) {
								skipped.push({
									relativePath,
									reason: `too large (${Math.round(stat.size / 1024)} KB)`,
								});
							} else {
								files.push({
									relativePath,
									mtimeMs: stat.mtimeMs,
								});
							}
						} catch {
							// Skip unreadable files
						}
					}
				}
			}
		} catch {
			return { files, skipped };
		}

		const queue: string[] = [...topLevelDirs];

		while (queue.length > 0) {
			if (signal?.aborted) return { files, skipped };

			const batch = queue.splice(0, SCAN_CONCURRENCY);
			const batchResults = await Promise.all(
				batch.map(async (dir) => {
					try {
						return await this.scanDir(dir, skipped);
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

		return { files, skipped };
	}

	private isExcluded(relativePath: string): boolean {
		const segments = relativePath.split("/");
		for (const pattern of this.settings.excludePatterns) {
			if (!pattern) continue;
			if (segments.some((seg) => seg === pattern)) return true;
			if (relativePath.startsWith(pattern + "/")) return true;
		}
		return false;
	}

	private async scanDir(
		dirPath: string,
		skipped: SkippedEntry[]
	): Promise<{ subdirs: string[]; files: FileEntry[] }> {
		const subdirs: string[] = [];
		const files: FileEntry[] = [];

		const dirents = await fs.promises.readdir(dirPath, {
			withFileTypes: true,
		});

		const statPromises: Promise<void>[] = [];

		for (const dirent of dirents) {
			const name = dirent.name;
			if (name.startsWith(".") || IGNORED_DIRS.has(name)) continue;

			const fullPath = path.join(dirPath, name);
			const relativePath = toVaultPath(
				path.relative(this.settings.sourcePath, fullPath)
			);

			if (dirent.isSymbolicLink()) {
				if (this.settings.skipSymlinks) continue;
				try {
					const stat = await fs.promises.stat(fullPath);
					if (stat.isDirectory()) {
						if (!this.isExcluded(relativePath)) {
							subdirs.push(fullPath);
						}
					} else if (
						stat.isFile() &&
						this.hasMatchingExtension(name)
					) {
						if (!this.isExcluded(relativePath)) {
							if (
								stat.size >
								this.settings.maxFileSizeKB * 1024
							) {
								skipped.push({
									relativePath,
									reason: `too large (${Math.round(stat.size / 1024)} KB)`,
								});
							} else {
								files.push({
									relativePath,
									mtimeMs: stat.mtimeMs,
								});
							}
						}
					}
				} catch {
					// Broken symlink
				}
				continue;
			}

			if (this.isExcluded(relativePath)) continue;

			if (dirent.isDirectory()) {
				subdirs.push(fullPath);
			} else if (dirent.isFile() && this.hasMatchingExtension(name)) {
				statPromises.push(
					fs.promises.stat(fullPath).then((stat) => {
						if (
							stat.size >
							this.settings.maxFileSizeKB * 1024
						) {
							skipped.push({
								relativePath,
								reason: `too large (${Math.round(stat.size / 1024)} KB)`,
							});
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

	// ── Cache ────────────────────────────────────────────

	private buildDestCache(): void {
		this.destCache.clear();
		if (!this.destPrefix) return;

		const prefix = this.destPrefix + "/";
		const allFiles = this.vault.getFiles();

		for (const file of allFiles) {
			if (
				file.path.startsWith(prefix) &&
				this.hasMatchingExtension(file.path)
			) {
				const relativePath = file.path.slice(prefix.length);
				this.destCache.set(relativePath, file.stat.mtime);
			}
		}
	}

	// ── Copy ─────────────────────────────────────────────

	private async copyFile(entry: FileEntry): Promise<void> {
		const sourceFull = path.join(
			this.settings.sourcePath,
			entry.relativePath
		);
		const vaultPath = `${this.destPrefix}/${entry.relativePath}`;

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

	// ── Log ──────────────────────────────────────────────

	private async writeLog(result: SyncResult): Promise<void> {
		if (!this.settings.syncLogEnabled) return;
		if (
			result.copied === 0 &&
			result.deleted === 0 &&
			result.conflicts === 0 &&
			result.errors === 0
		)
			return;

		const now = new Date();
		const timestamp = now.toISOString().replace("T", " ").slice(0, 19);

		let entry = `## ${timestamp}\n`;
		entry += `- Copied: ${result.copied}\n`;
		entry += `- Deleted: ${result.deleted}\n`;
		entry += `- Conflicts: ${result.conflicts}\n`;
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
