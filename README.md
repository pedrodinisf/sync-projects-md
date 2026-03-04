# Sync Projects MD

An Obsidian plugin that mirrors `.md` files from an external projects folder into your vault, preserving folder structure. Desktop only (uses Node.js `fs`).

## What it does

Point it at a directory of project folders (e.g. `~/Documents/PROJECTS`) and it copies every `.md` file into your vault under `1_PROJECTS/<dest_folder>/`, keeping the original directory tree intact. Only changed files are copied (mtime-based diffing).

## Features

### Core sync
- **One-way mirror** — source `.md` files are copied into the vault; vault files are never written back to source
- **Incremental** — only copies files whose mtime is newer than the vault copy
- **Batched I/O** — copies in batches of 5, yielding to the event loop between batches to keep Obsidian responsive
- **Auto-sync** — configurable timer (1-60 minutes), can be disabled
- **Orphan deletion** — optionally removes vault files whose source has been deleted
- **Ribbon icon** — click to sync manually; spins during sync
- **Command palette** — `Sync Projects MD: Sync now`
- **Status bar** — shows sync progress and last sync time (persisted across restarts)

### Filtering
- **Exclude patterns** — skip folders/files by name (e.g. `drafts`, `archive`). Matches exact path segments, so `drafts` matches `project/drafts/` but not `project/my_drafts/`
- **Selective project sync** — pick which top-level project folders to sync via a checklist in settings. When none are selected, all projects sync
- **Skip symlinks** — ignore symbolic links (enabled by default). When disabled, symlinks are resolved and followed
- **Max file size** — skip `.md` files larger than a configurable threshold (default 512 KB)

### Logging & notifications
- **Sync log** — after each sync with changes, appends a timestamped entry to `sync-log.md` in the destination folder, including copied/deleted/skipped/error counts and optional file-level details. Newest entries appear first
- **Verbose notifications** — toggle between a summary notice and a full per-file breakdown

## Settings

The settings tab is organized into sections:

| Section | Settings |
|---|---|
| **Paths** | Source path, Destination folder name |
| **Project Selection** | Scrollable checklist of project folders with Select all / Deselect all |
| **Filtering** | Exclude patterns (one per line), Skip symlinks toggle, Max file size (KB) |
| **Sync Behavior** | Auto-sync enabled, Auto-sync interval, Delete orphans |
| **Logging & Notifications** | Sync log toggle, Verbose notifications toggle |
| **Actions** | Sync now button |

## Installation

### Manual install

1. Clone or download this repository
2. `npm install`
3. `npm run build`
4. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/sync-projects-md/` directory
5. Enable the plugin in Obsidian Settings > Community plugins

### Development

```bash
npm run dev    # watch mode with sourcemaps
npm run build  # production build (minified, no sourcemaps)
```

## Architecture

```
src/
  types.ts        — PluginSettings, FileEntry, SyncResult, OnProgress
  sync-engine.ts  — SyncEngine class: scan, diff, copy, log
  settings.ts     — PluginSettingTab with all UI controls
  main.ts         — Plugin lifecycle, timer, ribbon, status bar
```

### How sync works

1. **Validate** source path is accessible
2. **Scan** source directory recursively, collecting `.md` files with their mtimes. Applies project filter (depth 1), exclude patterns, symlink policy, and file size guard during scan
3. **Build destination cache** from vault files on first run
4. **Diff** — compare source mtimes against cache to find files needing copy
5. **Copy** in batches of 5, reporting progress to the status bar
6. **Delete orphans** if enabled — remove vault files with no source counterpart
7. **Write sync log** entry if enabled and there were changes

### Ignored directories

The scanner always skips: `.git`, `.svn`, `.hg`, `node_modules`, `.obsidian`, `__pycache__`, `.venv`, `venv`, `.env`, `dist`, `build`, `.next`, `.nuxt`, `.cache`, `.DS_Store`, and any directory starting with `.`

## Compatibility

- Obsidian `>= 0.15.0`
- Desktop only (requires Node.js `fs` and `path`)
