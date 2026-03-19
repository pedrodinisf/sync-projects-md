import { App, TFolder } from "obsidian";

export function getAllVaultFolders(app: App): string[] {
	const folders: string[] = [];
	const root = app.vault.getRoot();
	collectFolders(root, folders);
	return folders.sort();
}

function collectFolders(folder: TFolder, result: string[]): void {
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			result.push(child.path);
			collectFolders(child, result);
		}
	}
}

export function createFolderSuggest(
	containerEl: HTMLElement,
	app: App,
	currentValue: string,
	onChange: (value: string) => void
): HTMLInputElement {
	const wrapper = containerEl.createDiv({ cls: "sync-folder-suggest" });
	const input = wrapper.createEl("input", { type: "text" });
	input.addClass("sync-folder-input");
	input.value = currentValue;
	input.placeholder = "Type to search vault folders...";

	const dropdown = wrapper.createDiv({ cls: "sync-folder-dropdown" });
	dropdown.style.display = "none";

	const folders = getAllVaultFolders(app);

	const showDropdown = (query: string) => {
		dropdown.empty();
		const lower = query.toLowerCase();
		const matches = lower
			? folders.filter((f) => f.toLowerCase().includes(lower))
			: folders;

		if (matches.length === 0) {
			dropdown.style.display = "none";
			return;
		}

		dropdown.style.display = "block";
		const limit = Math.min(matches.length, 30);
		for (let i = 0; i < limit; i++) {
			const item = dropdown.createDiv({ cls: "sync-folder-item" });
			item.setText(matches[i]);
			item.addEventListener("mousedown", (e) => {
				e.preventDefault(); // prevent input blur
				input.value = matches[i];
				dropdown.style.display = "none";
				onChange(matches[i]);
			});
		}
		if (matches.length > 30) {
			dropdown.createDiv({
				cls: "sync-folder-item sync-folder-more",
				text: `\u2026 and ${matches.length - 30} more`,
			});
		}
	};

	input.addEventListener("input", () => {
		showDropdown(input.value);
		onChange(input.value);
	});

	input.addEventListener("focus", () => {
		showDropdown(input.value);
	});

	input.addEventListener("blur", () => {
		dropdown.style.display = "none";
	});

	return input;
}
