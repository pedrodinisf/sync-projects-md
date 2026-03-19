import { Notice, Plugin } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, SyncResult } from "./types";
import { SyncEngine } from "./sync-engine";
import { SyncProjectsMdSettingTab } from "./settings";
import { SyncModal } from "./sync-modal";

export default class SyncProjectsMdPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	syncEngine: SyncEngine = null!;

	private timerHandle: ReturnType<typeof setInterval> | null = null;
	private isSyncing = false;
	private abortController: AbortController | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.syncEngine = new SyncEngine(this.app.vault, this.settings);

		// Ribbon icon — opens the sync modal
		this.ribbonIconEl = this.addRibbonIcon(
			"refresh-cw",
			"Sync Projects MD",
			() => new SyncModal(this.app, this).open()
		);

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		if (this.settings.lastSyncTimestamp > 0) {
			this.updateStatus(
				`Last sync: ${this.formatTimestamp(this.settings.lastSyncTimestamp)}`
			);
		} else {
			this.updateStatus("Sync: ready");
		}

		// Settings tab
		this.addSettingTab(new SyncProjectsMdSettingTab(this.app, this));

		// Command palette — direct sync (no modal)
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.runSync(),
		});

		this.addCommand({
			id: "open-sync-modal",
			name: "Open sync modal",
			callback: () => new SyncModal(this.app, this).open(),
		});

		// Start auto-sync timer
		this.restartTimer();

		// Initial sync after Obsidian finishes loading (only if configured)
		if (this.settings.sourcePath && this.settings.destPath) {
			this.registerInterval(
				window.setTimeout(() => this.runSync(), 3000) as unknown as number
			);
		}
	}

	onunload(): void {
		this.clearTimer();
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		// Migrate v2 → v3: destFolderName → destPath
		if (!this.settings.destPath && this.settings.destFolderName) {
			this.settings.destPath = `1_PROJECTS/${this.settings.destFolderName}`;
			await this.saveData(this.settings);
		}

		// Ensure syncFileExtensions exists
		if (
			!this.settings.syncFileExtensions ||
			this.settings.syncFileExtensions.length === 0
		) {
			this.settings.syncFileExtensions = [".md"];
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.syncEngine.updateSettings(this.settings);
	}

	restartTimer(): void {
		this.clearTimer();
		if (
			this.settings.autoSyncEnabled &&
			this.settings.sourcePath &&
			this.settings.destPath
		) {
			const ms = this.settings.syncIntervalMinutes * 60 * 1000;
			this.timerHandle = setInterval(() => this.runSync(), ms);
			this.registerInterval(this.timerHandle as unknown as number);
		}
	}

	private clearTimer(): void {
		if (this.timerHandle !== null) {
			clearInterval(this.timerHandle);
			this.timerHandle = null;
		}
	}

	async runSync(overrideConflicts = false): Promise<void> {
		if (this.isSyncing) return;

		if (!this.settings.destPath) {
			new Notice("Sync Projects MD: destination folder is not set.");
			return;
		}

		this.isSyncing = true;
		this.abortController = new AbortController();
		this.setSpinning(true);
		this.updateStatus("Syncing\u2026");

		let result: SyncResult;
		try {
			result = await this.syncEngine.sync(
				this.abortController.signal,
				(current, total) => {
					this.updateStatus(`Syncing ${current}/${total}\u2026`);
				},
				overrideConflicts
			);
		} catch (e) {
			this.updateStatus("Sync failed!");
			new Notice(`Sync Projects MD: ${e}`);
			this.isSyncing = false;
			this.setSpinning(false);
			return;
		}

		this.abortController = null;
		this.isSyncing = false;
		this.setSpinning(false);

		// Persist last sync timestamp
		this.settings.lastSyncTimestamp = Date.now();
		await this.saveSettings();

		this.updateStatus(
			`Last sync: ${this.formatTimestamp(this.settings.lastSyncTimestamp)}`
		);

		// Notification
		this.showResult(result);
	}

	private showResult(result: SyncResult): void {
		const parts: string[] = [];
		if (result.copied > 0) parts.push(`${result.copied} copied`);
		if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
		if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts`);
		if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
		if (result.errors > 0) parts.push(`${result.errors} errors`);
		if (parts.length === 0) parts.push("Already up to date");

		const summary = `Sync: ${parts.join(", ")} (${result.elapsedMs}ms)`;

		if (
			this.settings.verboseNotifications &&
			result.details.length > 0
		) {
			new Notice(
				`${summary}\n${result.details.join("\n")}`,
				10000
			);
		} else {
			new Notice(summary);
		}
	}

	formatTimestamp(ts: number): string {
		const date = new Date(ts);
		const now = new Date();
		const time = date.toLocaleTimeString("en-GB", { hour12: false });

		const isToday =
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate();

		if (isToday) return time;

		const yesterday = new Date(now);
		yesterday.setDate(yesterday.getDate() - 1);
		const isYesterday =
			date.getFullYear() === yesterday.getFullYear() &&
			date.getMonth() === yesterday.getMonth() &&
			date.getDate() === yesterday.getDate();

		if (isYesterday) return `Yesterday ${time.slice(0, 5)}`;

		return `${date.toLocaleDateString("en-GB")} ${time.slice(0, 5)}`;
	}

	private setSpinning(spinning: boolean): void {
		if (!this.ribbonIconEl) return;
		if (spinning) {
			this.ribbonIconEl.addClass("sync-projects-spinning");
		} else {
			this.ribbonIconEl.removeClass("sync-projects-spinning");
		}
	}

	private updateStatus(text: string): void {
		if (this.statusBarEl) {
			this.statusBarEl.setText(text);
		}
	}
}
