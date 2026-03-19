export interface PluginSettings {
	sourcePath: string;
	destFolderName: string; // deprecated — kept for v2 migration
	destPath: string;
	syncIntervalMinutes: number;
	autoSyncEnabled: boolean;
	deleteOrphans: boolean;
	verboseNotifications: boolean;
	excludePatterns: string[];
	includedProjects: string[];
	syncLogEnabled: boolean;
	skipSymlinks: boolean;
	maxFileSizeKB: number;
	lastSyncTimestamp: number;
	syncFileExtensions: string[];
	conflictDetection: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	sourcePath: "",
	destFolderName: "",
	destPath: "",
	syncIntervalMinutes: 5,
	autoSyncEnabled: true,
	deleteOrphans: false,
	verboseNotifications: false,
	excludePatterns: [],
	includedProjects: [],
	syncLogEnabled: true,
	skipSymlinks: true,
	maxFileSizeKB: 512,
	lastSyncTimestamp: 0,
	syncFileExtensions: [".md"],
	conflictDetection: true,
};

export interface FileEntry {
	/** Path relative to the source root, e.g. "my_project/README.md" */
	relativePath: string;
	/** Source file mtime in ms */
	mtimeMs: number;
}

export interface SkippedEntry {
	relativePath: string;
	reason: string;
}

export interface SyncResult {
	copied: number;
	deleted: number;
	skipped: number;
	conflicts: number;
	errors: number;
	elapsedMs: number;
	details: string[];
}

export type OnProgress = (current: number, total: number) => void;

export type DryRunAction = "copy" | "delete" | "conflict" | "skip";

export interface DryRunEntry {
	relativePath: string;
	action: DryRunAction;
	reason?: string;
}

export interface DryRunResult {
	entries: DryRunEntry[];
	toCopy: number;
	toDelete: number;
	conflicts: number;
	skipped: number;
}
