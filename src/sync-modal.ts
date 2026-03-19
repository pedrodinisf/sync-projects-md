import { App, Modal, Setting } from "obsidian";
import type SyncProjectsMdPlugin from "./main";
import { DryRunResult, DryRunAction, PluginSettings } from "./types";
import { SyncEngine } from "./sync-engine";
import { createFolderSuggest } from "./folder-suggest";

export class SyncModal extends Modal {
	private plugin: SyncProjectsMdPlugin;
	private previewEl: HTMLElement = null!;
	private summaryEl: HTMLElement = null!;
	private syncBtn: HTMLButtonElement = null!;
	private overrideConflicts = false;

	// Local copies — only committed on "Sync Now"
	private localDestPath: string;
	private localDeleteOrphans: boolean;
	private localSyncLogEnabled: boolean;
	private localConflictDetection: boolean;

	constructor(app: App, plugin: SyncProjectsMdPlugin) {
		super(app);
		this.plugin = plugin;
		this.localDestPath = plugin.settings.destPath;
		this.localDeleteOrphans = plugin.settings.deleteOrphans;
		this.localSyncLogEnabled = plugin.settings.syncLogEnabled;
		this.localConflictDetection = plugin.settings.conflictDetection;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("sync-projects-modal");

		// ── Header ─────────────────────────────────────────
		contentEl.createEl("h2", { text: "Sync Projects MD" });

		if (this.plugin.settings.lastSyncTimestamp > 0) {
			const ts = this.plugin.formatTimestamp(
				this.plugin.settings.lastSyncTimestamp
			);
			contentEl.createEl("p", {
				text: `Last sync: ${ts}`,
				cls: "sync-modal-last-sync",
			});
		}

		// ── Destination ────────────────────────────────────
		const destRow = contentEl.createDiv({ cls: "sync-modal-field" });
		destRow.createEl("label", {
			text: "Destination folder",
			cls: "sync-modal-label",
		});
		destRow.createEl("small", {
			text: "Vault folder where synced files will be placed",
			cls: "sync-modal-desc",
		});
		createFolderSuggest(
			destRow,
			this.app,
			this.localDestPath,
			(value) => {
				this.localDestPath = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
				this.clearPreview();
			}
		);

		// ── Quick Toggles ──────────────────────────────────
		new Setting(contentEl)
			.setName("Delete orphans")
			.setDesc("Remove vault files whose source was deleted")
			.addToggle((t) =>
				t.setValue(this.localDeleteOrphans).onChange((v) => {
					this.localDeleteOrphans = v;
					this.clearPreview();
				})
			);

		new Setting(contentEl)
			.setName("Sync log")
			.setDesc("Write sync results to sync-log.md")
			.addToggle((t) =>
				t.setValue(this.localSyncLogEnabled).onChange((v) => {
					this.localSyncLogEnabled = v;
				})
			);

		new Setting(contentEl)
			.setName("Conflict detection")
			.setDesc("Flag files edited in both source and vault")
			.addToggle((t) =>
				t.setValue(this.localConflictDetection).onChange((v) => {
					this.localConflictDetection = v;
					this.clearPreview();
				})
			);

		// ── Preview area ───────────────────────────────────
		this.previewEl = contentEl.createDiv({ cls: "sync-preview" });
		this.summaryEl = contentEl.createDiv({ cls: "sync-preview-summary" });

		// ── Buttons ────────────────────────────────────────
		const btnRow = contentEl.createDiv({ cls: "sync-modal-buttons" });

		const previewBtn = btnRow.createEl("button", {
			text: "Preview Changes",
			cls: "sync-modal-btn",
		});
		previewBtn.addEventListener("click", () => this.runPreview());

		this.syncBtn = btnRow.createEl("button", {
			text: "Sync Now",
			cls: "mod-cta sync-modal-btn",
		});
		this.syncBtn.addEventListener("click", () => this.runSync());
	}

	private clearPreview(): void {
		this.previewEl.empty();
		this.summaryEl.empty();
		this.overrideConflicts = false;
	}

	private getLocalSettings(): PluginSettings {
		return {
			...this.plugin.settings,
			destPath: this.localDestPath,
			deleteOrphans: this.localDeleteOrphans,
			syncLogEnabled: this.localSyncLogEnabled,
			conflictDetection: this.localConflictDetection,
		};
	}

	private async runPreview(): Promise<void> {
		this.clearPreview();
		this.previewEl.createEl("p", {
			text: "Scanning\u2026",
			cls: "sync-preview-loading",
		});

		try {
			const settings = this.getLocalSettings();
			const engine = new SyncEngine(this.app.vault, settings);
			const result = await engine.dryRun();
			this.renderPreview(result);
		} catch (e) {
			this.previewEl.empty();
			this.previewEl.createEl("p", {
				text: `Error: ${e}`,
				cls: "sync-preview-error",
			});
		}
	}

	private renderPreview(result: DryRunResult): void {
		this.previewEl.empty();
		this.summaryEl.empty();

		if (result.entries.length === 0) {
			this.previewEl.createEl("p", {
				text: "Everything is up to date.",
				cls: "sync-preview-empty",
			});
			return;
		}

		// Summary line
		const parts: string[] = [];
		if (result.toCopy > 0) parts.push(`${result.toCopy} to copy`);
		if (result.toDelete > 0) parts.push(`${result.toDelete} to delete`);
		if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts`);
		if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
		this.summaryEl.createEl("p", {
			text: parts.join("  \u00b7  "),
			cls: "sync-summary-text",
		});

		// Conflict override toggle
		if (result.conflicts > 0) {
			new Setting(this.summaryEl)
				.setName("Overwrite conflicting files")
				.addToggle((t) =>
					t.setValue(this.overrideConflicts).onChange((v) => {
						this.overrideConflicts = v;
					})
				);
		}

		// Entry list
		const listEl = this.previewEl.createDiv({ cls: "sync-preview-list" });

		const icons: Record<DryRunAction, string> = {
			copy: "+",
			delete: "\u2212",
			conflict: "\u26a0",
			skip: "\u25cb",
		};

		const actionOrder: DryRunAction[] = [
			"conflict",
			"copy",
			"delete",
			"skip",
		];
		const sorted = [...result.entries].sort(
			(a, b) =>
				actionOrder.indexOf(a.action) - actionOrder.indexOf(b.action)
		);

		const maxShow = 100;
		const toShow = sorted.slice(0, maxShow);

		for (const entry of toShow) {
			const row = listEl.createDiv({
				cls: `sync-preview-row sync-action-${entry.action}`,
			});
			row.createSpan({
				text: icons[entry.action],
				cls: "sync-preview-icon",
			});
			row.createSpan({
				text: entry.relativePath,
				cls: "sync-preview-path",
			});
			if (entry.reason) {
				row.createSpan({
					text: ` (${entry.reason})`,
					cls: "sync-preview-reason",
				});
			}
		}

		if (sorted.length > maxShow) {
			listEl.createDiv({
				text: `\u2026 and ${sorted.length - maxShow} more entries`,
				cls: "sync-preview-more",
			});
		}
	}

	private async runSync(): Promise<void> {
		// Commit local settings
		Object.assign(this.plugin.settings, {
			destPath: this.localDestPath,
			deleteOrphans: this.localDeleteOrphans,
			syncLogEnabled: this.localSyncLogEnabled,
			conflictDetection: this.localConflictDetection,
		});
		await this.plugin.saveSettings();
		this.plugin.syncEngine.invalidateCache();
		this.close();
		await this.plugin.runSync(this.overrideConflicts);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
