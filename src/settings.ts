import { App, PluginSettingTab, Setting } from "obsidian";
import type SyncProjectsMdPlugin from "./main";

export class SyncProjectsMdSettingTab extends PluginSettingTab {
	plugin: SyncProjectsMdPlugin;

	constructor(app: App, plugin: SyncProjectsMdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Paths ──────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Paths" });

		new Setting(containerEl)
			.setName("Source path")
			.setDesc("Absolute path to the folder containing your projects")
			.addText((text) =>
				text
					.setPlaceholder("/path/to/your/projects")
					.setValue(this.plugin.settings.sourcePath)
					.onChange(async (value) => {
						this.plugin.settings.sourcePath = value.trim();
						await this.plugin.saveSettings();
						this.plugin.syncEngine.invalidateCache();
					})
			);

		new Setting(containerEl)
			.setName("Destination folder name")
			.setDesc("Subfolder inside 1_PROJECTS/ in your vault")
			.addText((text) =>
				text
					.setPlaceholder("mac_projects")
					.setValue(this.plugin.settings.destFolderName)
					.onChange(async (value) => {
						this.plugin.settings.destFolderName = value.trim();
						await this.plugin.saveSettings();
						this.plugin.syncEngine.invalidateCache();
					})
			);

		// ── Project Selection ──────────────────────────────────
		containerEl.createEl("h3", { text: "Project Selection" });

		const projectDesc = containerEl.createEl("p", {
			text: "Select which projects to sync. If none are selected, all projects are synced.",
			cls: "setting-item-description",
		});
		projectDesc.style.marginBottom = "8px";

		const projectContainer = containerEl.createDiv();
		projectContainer.style.marginBottom = "12px";

		// Buttons row
		const btnRow = projectContainer.createDiv();
		btnRow.style.marginBottom = "6px";
		btnRow.style.display = "flex";
		btnRow.style.gap = "8px";

		const selectAllBtn = btnRow.createEl("button", { text: "Select all" });
		const deselectAllBtn = btnRow.createEl("button", { text: "Deselect all" });

		// Scrollable checklist
		const listEl = projectContainer.createDiv();
		listEl.style.maxHeight = "200px";
		listEl.style.overflowY = "auto";
		listEl.style.border = "1px solid var(--background-modifier-border)";
		listEl.style.borderRadius = "4px";
		listEl.style.padding = "6px";

		// Load projects asynchronously
		this.plugin.syncEngine.listProjects().then((projects) => {
			if (projects.length === 0) {
				listEl.createEl("em", { text: "No projects found at source path" });
				return;
			}

			const checkboxes: HTMLInputElement[] = [];

			for (const name of projects) {
				const row = listEl.createDiv();
				row.style.display = "flex";
				row.style.alignItems = "center";
				row.style.gap = "6px";
				row.style.padding = "2px 0";

				const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
				cb.checked = this.plugin.settings.includedProjects.includes(name);
				row.createEl("span", { text: name });

				cb.addEventListener("change", async () => {
					const list = this.plugin.settings.includedProjects;
					if (cb.checked) {
						if (!list.includes(name)) list.push(name);
					} else {
						const idx = list.indexOf(name);
						if (idx >= 0) list.splice(idx, 1);
					}
					await this.plugin.saveSettings();
				});

				checkboxes.push(cb);
			}

			selectAllBtn.addEventListener("click", async () => {
				this.plugin.settings.includedProjects = [...projects];
				for (const cb of checkboxes) cb.checked = true;
				await this.plugin.saveSettings();
			});

			deselectAllBtn.addEventListener("click", async () => {
				this.plugin.settings.includedProjects = [];
				for (const cb of checkboxes) cb.checked = false;
				await this.plugin.saveSettings();
			});
		});

		// ── Filtering ──────────────────────────────────────────
		containerEl.createEl("h3", { text: "Filtering" });

		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc("Folder/file name patterns to exclude (one per line). Matches path prefixes.")
			.addTextArea((textArea) =>
				textArea
					.setPlaceholder("drafts\narchive\ntmp")
					.setValue(this.plugin.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Skip symlinks")
			.setDesc("Ignore symbolic links during scan")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.skipSymlinks)
					.onChange(async (value) => {
						this.plugin.settings.skipSymlinks = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max file size (KB)")
			.setDesc("Skip .md files larger than this size")
			.addText((text) =>
				text
					.setPlaceholder("512")
					.setValue(String(this.plugin.settings.maxFileSizeKB))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxFileSizeKB = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// ── Sync Behavior ──────────────────────────────────────
		containerEl.createEl("h3", { text: "Sync Behavior" });

		new Setting(containerEl)
			.setName("Auto-sync enabled")
			.setDesc("Automatically sync on a timer")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.restartTimer();
					})
			);

		new Setting(containerEl)
			.setName("Auto-sync interval")
			.setDesc(
				`Sync every ${this.plugin.settings.syncIntervalMinutes} minute(s)`
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 60, 1)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
						this.plugin.restartTimer();
					})
			);

		new Setting(containerEl)
			.setName("Delete orphans")
			.setDesc(
				"Delete vault files whose source has been removed (use with caution)"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deleteOrphans)
					.onChange(async (value) => {
						this.plugin.settings.deleteOrphans = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Logging & Notifications ────────────────────────────
		containerEl.createEl("h3", { text: "Logging & Notifications" });

		new Setting(containerEl)
			.setName("Sync log")
			.setDesc("Write a log entry after each sync to sync-log.md")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncLogEnabled)
					.onChange(async (value) => {
						this.plugin.settings.syncLogEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Verbose notifications")
			.setDesc("Show per-file details instead of just a summary")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.verboseNotifications)
					.onChange(async (value) => {
						this.plugin.settings.verboseNotifications = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Actions ────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Manually trigger a sync")
			.addButton((button) =>
				button.setButtonText("Sync Now").onClick(() => {
					this.plugin.runSync();
				})
			);
	}
}
