export interface PluginSettings {
	sourcePath: string;
	destFolderName: string;
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
}

export const DEFAULT_SETTINGS: PluginSettings = {
	sourcePath: "",
	destFolderName: "mac_projects",
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
};

export interface FileEntry {
	/** Path relative to the source root, e.g. "my_project/README.md" */
	relativePath: string;
	/** Source file mtime in ms */
	mtimeMs: number;
}

export interface SyncResult {
	copied: number;
	deleted: number;
	skipped: number;
	errors: number;
	elapsedMs: number;
	details: string[];
}

export type OnProgress = (current: number, total: number) => void;
