# Sync Projects MD

An Obsidian plugin that mirrors files from an external projects folder into your vault, preserving folder structure. Desktop only (uses Node.js `fs`).

## What it does

Point it at a directory of project folders (e.g. `~/Documents/PROJECTS`) and it copies matching files into any vault folder you choose, keeping the original directory tree intact. Only changed files are copied (mtime-based diffing).

## Features

### Sync modal

Click the ribbon icon to open a sync modal with:
- **Destination folder picker** — searchable autocomplete of all vault folders (including nested paths)
- **Quick toggles** — delete orphans, sync log, conflict detection
- **Dry-run preview** — see what would be copied, deleted, skipped, or flagged as a conflict before committing
- **Overwrite conflicts toggle** — when conflicts are detected, choose whether to force-overwrite
- **Sync Now button** — commits settings and runs the sync

### Core sync
- **One-way mirror** — source files are copied into the vault; vault files are never written back to source
- **Incremental** — only copies files whose mtime is newer than the vault copy
- **Configurable file types** — sync `.md` by default, optionally add `.txt`, `.canvas`, `.json`, etc.
- **Batched I/O** — copies in batches of 5, yielding to the event loop between batches to keep Obsidian responsive
- **Auto-sync** — configurable timer (1–60 minutes), can be disabled
- **Orphan deletion** — optionally removes vault files whose source has been deleted
- **Conflict detection** — flags files that were edited in both the source and the vault since the last sync, instead of silently overwriting
- **Command palette** — `Sync Projects MD: Sync now` (direct sync, no modal) and `Sync Projects MD: Open sync modal`
- **Status bar** — shows sync progress and last sync time (persisted across restarts)

### Filtering
- **Exclude patterns** — skip folders/files by name (e.g. `drafts`, `archive`). Matches exact path segments
- **Selective project sync** — pick which top-level project folders to sync via a checklist in settings (with search/filter). When none are selected, all projects sync
- **Skip symlinks** — ignore symbolic links (enabled by default). When disabled, symlinks are resolved and followed
- **Max file size** — skip files larger than a configurable threshold (default 512 KB)

### Logging & notifications
- **Sync log** — after each sync with changes, appends a timestamped entry to `sync-log.md` in the destination folder, including copied/deleted/conflicts/skipped/error counts and optional file-level details
- **Verbose notifications** — toggle between a summary notice and a full per-file breakdown

## Settings

The settings tab is organized into sections:

| Section | Settings |
|---|---|
| **Paths** | Source path, Destination folder (with autocomplete) |
| **Project Selection** | Search/filter box, Scrollable checklist with Select all / Deselect all |
| **File Types** | File extensions to sync (one per line) |
| **Filtering** | Exclude patterns, Skip symlinks, Max file size |
| **Sync Behavior** | Auto-sync enabled, Auto-sync interval, Delete orphans, Conflict detection |
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
npm run dev          # dev build with sourcemaps
npm run build        # production build (minified, no sourcemaps)
npm run dev:deploy   # dev build + copy to local Obsidian vault for testing
```

To use `dev:deploy`, edit the `DEST` path in `deploy.mjs` to point to your vault's plugin folder.

## Architecture

```
src/
  types.ts          — PluginSettings, FileEntry, SyncResult, DryRunResult, etc.
  sync-engine.ts    — SyncEngine class: scan, diff, copy, log, dryRun, conflict detection
  sync-modal.ts     — SyncModal: ribbon-click modal with preview and sync
  folder-suggest.ts — Reusable vault folder autocomplete input
  settings.ts       — PluginSettingTab with all UI controls
  main.ts           — Plugin lifecycle, timer, ribbon, status bar, migration
```

### How sync works

1. **Validate** source path is accessible
2. **Scan** source directory recursively, collecting files with matching extensions and their mtimes. Applies project filter (depth 1), exclude patterns, symlink policy, and file size guard during scan
3. **Build destination cache** from vault files on first run
4. **Diff** — compare source mtimes against cache to find files needing copy. Flag conflicts where both source and vault were modified since last sync
5. **Copy** in batches of 5, reporting progress to the status bar
6. **Delete orphans** if enabled — remove vault files with no source counterpart (preserves sync-log.md)
7. **Write sync log** entry if enabled and there were changes

### Ignored directories

The scanner always skips: `.git`, `.svn`, `.hg`, `node_modules`, `.obsidian`, `__pycache__`, `.venv`, `venv`, `.env`, `dist`, `build`, `.next`, `.nuxt`, `.cache`, `.DS_Store`, and any directory starting with `.`

## Compatibility

- Obsidian `>= 0.15.0`
- Desktop only (requires Node.js `fs` and `path`)
- Cross-platform: Windows, macOS, and Linux (path separators are normalized internally)
