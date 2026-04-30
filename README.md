# Fluent Explorer

**A Windows 11–styled File Manager & Photo Viewer built for Linux Mint (and other Linux distros)**

> Fast thumbnails. Tabbed browsing. Built-in image viewer. Dark mode. Network shares. All in one app.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Linux-green.svg)
![Built With](https://img.shields.io/badge/built%20with-Electron%2028-purple.svg)

---

## What is this?

Fluent Explorer brings the look and feel of Windows 11 File Explorer to Linux. It's a full file manager with an integrated photo viewer, designed for people who switched from Windows and miss that UI — or anyone who wants a fast, modern file browser with image previews.

It consists of two apps that share a single Electron process:

- **Fluent Explorer** — tabbed file manager with thumbnails, sorting, bookmarks, and network support
- **Fluent Photos** — image viewer with gallery mode, filmstrip navigation, and zoom controls

Both apps appear as separate windows in your taskbar. Closing Photos does not close Explorer.

---

## Features

### File Manager
- Windows 11 visual design (title bar, toolbar, sidebar, breadcrumb address bar)
- **Multiple tabs** in the same window (Ctrl+T / Ctrl+W)
- **Dark and Light themes** (persisted across sessions)
- **Thumbnail previews** for images and videos (ffmpeg)
- **4 icon sizes**: Small, Medium, Large, Extra Large
- **Grid / List / Tile** view modes
- **Advanced sorting**: Name (natural sort), Date Modified, Date Created, Size, Type, Extension
- **Ascending / Descending** toggle with per-folder persistence
- **Group by**: None, Type, Date
- **Smart defaults**: Pictures → newest first, Downloads → newest first
- **Rubber-band selection** (click and drag to select multiple files)
- **Shift+Home / Shift+End** to select to top/bottom
- Right-click context menu: Select all above / Select all below
- **Favourites and Bookmarks** in sidebar (add/remove any folder)
- **Network locations**: Add SMB/CIFS home server shares, scan LAN with avahi
- **Open terminal** in current folder (toolbar button or right-click)
- Cut / Copy / Paste with **global clipboard** (works across tabs and windows)
- **Shift+Delete** for permanent deletion (bypasses trash, with confirmation dialog)
- Drag and drop files into folders to copy
- Native OS-level drag (works between Explorer and Photos windows)
- **Session restore**: reopens all tabs where you left off
- **Clear session** button (🧹) for a fresh start

### Photo Viewer
- Opens directly on the clicked image (no folder re-scan)
- **Follows the exact sort order** from the file manager
- Left/Right arrow keys for instant navigation (5 images preloaded in each direction)
- Dual-image element swap (no DOM rebuild on navigate)
- Filmstrip thumbnail bar at the bottom
- Zoom controls: Fit / Fill / + / − / mouse
- Info panel with file details
- Gallery mode with date-grouped thumbnails
- **Scan Subfolders** button for deep gallery
- Native drag from viewer to any folder or desktop
- Standalone launch from App Menu

### Performance
- **SHA-256 thumbnail cache** on disk (~/.cache/winex-thumbs/) — no hash collisions
- **Three-tier cache**: renderer memory → main process memory → disk
- **Viewport-priority loading**: visible thumbnails load first, off-screen loads later
- **Concurrency limiter**: max 3 simultaneous thumbnail generations (prevents freezing)
- **Request-ID system**: prevents stale async responses from overwriting correct thumbnails
- **Non-destructive selection**: clicking/selecting files toggles CSS classes only (no re-render, no thumbnail reload)
- Vanilla JS — zero framework overhead
- Video thumbnails via ffmpeg with 6-second timeout

---

## Screenshots

*Coming soon — PRs welcome!*

---

## System Requirements

| Component | Minimum |
|-----------|---------|
| OS | Linux Mint 21+, Ubuntu 22.04+, or any Debian-based distro |
| Node.js | 18+ (installer will set up v20 if missing) |
| RAM | 4 GB (8+ recommended for large image folders) |
| GPU | Any (nativeImage uses GPU acceleration when available) |
| Optional | ffmpeg (for video thumbnails), smbclient (for network shares) |

**Tested on**: Linux Mint 22.2 Cinnamon, AMD Ryzen 5 2600, GTX 1070 Ti, 16 GB RAM

---

## Installation

### Quick Install

```bash
# Download
wget https://github.com/ssfahim/fluent-explorer/releases/download/v1.0.0/fluent-explorer-v1.0.0.tar.gz

# Extract and install
tar xzf fluent-explorer-v1.0.0.tar.gz
cd winex9
chmod +x install.sh
./install.sh
```

### From Source

```bash
git clone https://github.com/ssfahim/fluent-explorer.git
cd fluent-explorer
chmod +x install.sh
./install.sh
```

The installer will:
1. Install Node.js 20 (if not present)
2. Install ffmpeg and smbclient (if not present)
3. Install Electron 28
4. Create desktop launchers for both apps
5. Set up the thumbnail cache directory

### Launch

- Search **"Fluent Explorer"** in your App Menu
- Search **"Fluent Photos"** in your App Menu
- Or from terminal:
  ```bash
  ~/.local/share/win-explorer/launch-explorer.sh
  ~/.local/share/win-explorer/launch-photos.sh
  ```

### Set as Default Apps

```bash
# Default file manager
xdg-mime default win-explorer.desktop inode/directory

# Default image viewer
xdg-mime default win-photos.desktop image/jpeg
xdg-mime default win-photos.desktop image/png
xdg-mime default win-photos.desktop image/gif
xdg-mime default win-photos.desktop image/webp
```

---

## Keyboard Shortcuts

### File Manager

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+A` | Select all |
| `Ctrl+C` | Copy |
| `Ctrl+X` | Cut |
| `Ctrl+V` | Paste |
| `Delete` | Move to trash |
| `Shift+Delete` | Permanent delete |
| `F2` | Rename |
| `F5` | Refresh |
| `F12` | Debug log viewer |
| `Backspace` / `Alt+←` | Go back |
| `Alt+→` | Go forward |
| `Alt+↑` | Go up one level |
| `Shift+Home` | Select all above |
| `Shift+End` | Select all below |

### Photo Viewer

| Shortcut | Action |
|----------|--------|
| `←` / `→` | Previous / Next image |
| `Escape` | Close viewer / Return to gallery |
| `+` / `-` | Zoom in / out |
| `0` | Reset zoom to fit |
| `I` | Toggle info panel |

---

## Architecture

```
fluent-explorer/
├── main.js              # Electron main process (shared by both apps)
├── preload.js           # IPC bridge (shared by both windows)
├── explorer.html         # File Manager UI (single HTML file)
├── photos.html           # Photo Viewer UI (single HTML file)
├── package.json
├── install.sh
├── uninstall.sh
├── icon.svg
└── README.md
```

### Key Design Decisions

- **Single Electron process, multiple windows**: Explorer and Photos share one Node.js process. This enables shared clipboard, native drag-and-drop between windows, and shared thumbnail cache — while appearing as separate apps in the taskbar.

- **SHA-256 thumbnail hashing**: Earlier versions used truncated base64 encoding of the file path as cache keys, which caused hash collisions for files with similar paths (e.g., `2025-01-23_02-50-29.jpg` and `2025-01-23_02-50-57.jpg`). SHA-256 eliminates this entirely.

- **Request-ID system for thumbnails**: Each `<img>` element gets a unique request ID when a thumbnail is requested. When the async response arrives, it verifies the request ID still matches before setting `src`. This prevents stale responses from overwriting correct thumbnails during scrolling.

- **Non-destructive selection**: Clicking files toggles CSS classes on existing DOM elements instead of rebuilding innerHTML. This preserves loaded thumbnails across selection changes.

- **Sorted image list passed via IPC**: When opening an image in Photos from Explorer, the exact sorted file list is passed through the main process. Photos uses this list directly — no re-scanning, no re-sorting, guaranteed order match.

---

## Configuration Files

| File | Purpose |
|------|---------|
| `~/.config/winex-settings.json` | Theme, icon size |
| `~/.config/winex-bookmarks.json` | Favourites and bookmarks |
| `~/.config/winex-sortprefs.json` | Per-folder sort preferences |
| `~/.config/winex-networks.json` | Network share locations |
| `~/.config/winex-session.json` | Last session (open tabs) |
| `~/.cache/winex-thumbs/` | Thumbnail cache (SHA-256 keyed) |
| `~/.cache/winex-debug.log` | Debug log (thumbnail events) |

---

## Debugging

Press **F12** in the file manager to open the thumbnail debug log viewer. It shows:
- Cache hits and misses
- Thumbnail generation events
- Stale request skips (race condition prevention)
- Request IDs and paths

The main process also writes to `~/.cache/winex-debug.log`.

To clear the thumbnail cache and start fresh:
```bash
rm -rf ~/.cache/winex-thumbs
```

Or use the **🧹 Clear** button in the toolbar, then press F12 → "Clear Thumb Cache".

---

## Uninstall

```bash
bash ~/.local/share/win-explorer/uninstall.sh
```

This removes:
- Application files
- Desktop launchers
- Thumbnail cache
- Configuration files

---

## Contributing

Contributions are welcome! Here are some ideas:

- [ ] EXIF-based sorting (date taken, resolution, orientation)
- [ ] Drag-and-drop tab reordering
- [ ] Split pane view (dual panel)
- [ ] Built-in image editing (crop, rotate, resize)
- [ ] Batch rename tool
- [ ] Archive extraction (zip, tar, 7z)
- [ ] Custom themes / accent colors
- [ ] Wayland support
- [ ] NFS network share support
- [ ] Trash management view
- [ ] File size treemap visualization
- [ ] Integration with cloud storage (Google Drive, Dropbox)

### Development Setup

```bash
git clone https://github.com/ssfahim/fluent-explorer.git
cd fluent-explorer
npm install
npm start          # Launch Explorer
npm run photos     # Launch Photos standalone
```

---

## License

MIT License — free to use, modify, and distribute.

---

## Credits

Built with [Electron](https://www.electronjs.org/) for Linux Mint.

Inspired by Windows 11 File Explorer and Windows Photos.

---

*If you find this useful, give it a ⭐ on GitHub!*
