# Testing Checklist (run on the Linux PC)

> ⚠️ **DEPLOY FIRST:** the app runs from `~/.local/share/win-explorer/`, not the git repo.
> After `git pull`, run **`./install.sh`** (or launch from the repo with `npm start`) or you'll
> still be running the old code.

## v1.9.0 — viewer fullscreen + delete
- [ ] In the image viewer, click **⛶** (or press **F11**): the window goes **true fullscreen** —
      titlebar + top toolbar + bottom status bar all disappear, only the image shows.
- [ ] Press **Esc** (or ⛶ / F11 again): exits fullscreen, everything comes back. Try triggering
      fullscreen with the window-manager's own F11 too — the panels should still hide/show correctly.
- [ ] **Delete** in the viewer sends the current photo to Trash and shows the next one (check it
      lands in your Trash / is recoverable).
- [ ] Reminder: **double-clicking the image** still does the in-window immersive (panels fade, window
      stays the same size) — that's separate from ⛶ fullscreen.
- [ ] **F11** in the Explorer window also toggles fullscreen (hides its titlebar); Esc exits.

## v1.8.0 — Explorer modernization
- [ ] Click a file, then use **←/→/↑/↓** to move the selection (↑/↓ moves a whole row in grid view);
      **Shift+arrows** extends; **Home/End** jump to first/last; **Enter** opens the focused item.
- [ ] **Ctrl+L** or **Alt+D** (or click the blank part of the breadcrumb) → type/paste a path → Enter
      navigates; Esc cancels.
- [ ] **F2** on a selected file → edit the name in place (stem pre-selected) → Enter renames, Esc cancels.
- [ ] **Ctrl+F** focuses the search box; **Ctrl+Shift+N** creates a new folder.
- [ ] Arrow keys / type-ahead do nothing while you're typing in the search or address box (no interference).

## v1.7.0
- [ ] **Thumbnails appear** for your JPEG folders (the sharp "unsupported image format" failure now
      falls back to nativeImage). Check `~/.cache/winex-debug.log` — `sharp_fail_fallback` entries are
      expected/fine; persistent `thumb_error` means even nativeImage failed (rare).
- [ ] **Immersive viewer:** open an image → double-click it (or the ⛶ button) → all chrome hides,
      only the image shows on black. Move the mouse → chrome returns; idle ~3s → it auto-hides.
- [ ] **Navigation:** ‹ › chevrons and ←/→ keys move between images; Esc returns to the gallery.
      Paging feels instant (blurred backdrop + preloaded neighbours).
- [ ] **F** toggles filmstrip; wheel / `+` `-` zoom; `Ctrl+0` fit; `F11` fullscreen.
- [ ] **Explorer type-ahead:** with a folder focused, type the first letters of a file → it selects/
      scrolls to it.
- [ ] App feels smoother (GPU accel). If you get visual artifacts or a black window, relaunch with
      `FLUENT_NO_GPU=1 ~/.local/share/win-explorer/launch-explorer.sh`.

## v1.6.2 fixes
- [ ] Open a folder with **thousands of images/videos** → thumbnails load (progressively as you
      scroll). Previously they barely loaded at all.
- [ ] Press **Ctrl+R** → refreshes the current folder in place; does NOT reload the app to Home.



These changes were written and statically verified on macOS, but the SMB / clipboard /
drag code paths only execute on Linux. Run through this on your home PC after
`./install.sh` (or `npm start` from source).

## 1. Back / Forward history (the dedup bug)
- [ ] Open a folder, click into a subfolder, then click the **current** breadcrumb segment or the
      active sidebar item a few times. Press **Back once** → it should move to the previous folder
      immediately (before the fix it needed 2–3 presses or did nothing).
- [ ] Back → Forward returns you to where you were.
- [ ] Navigate A → B → C, press Back to B, then open D. Forward should be disabled (C was truncated).
- [ ] Scroll halfway down a big folder, enter a subfolder, press **Back** → scroll position restored.
- [ ] Switch between tabs → each tab restores its own scroll position.

## 2. SMB / network shares
- [ ] Add a share (sidebar Network → +). Browsing a folder with many files should feel much faster
      (parallel stat + 64-thread pool). 
- [ ] A folder containing one unreachable/locked file should still list (file shows with no size/date
      instead of freezing or vanishing).
- [ ] If you have `cifs-utils` installed and click connect, you may get a **pkexec password prompt**
      offering the fast kernel mount. Cancelling it falls back to the gvfs mount (no prompt path).
- [ ] "Test Connection" still pings; "Scan LAN" still finds hosts.

## 3. Clipboard interop (the big one)
- [ ] Requires `xclip` (X11) or `wl-clipboard` (Wayland) — the installer now adds them.
- [ ] Copy a file in **Nemo/Nautilus**, switch to Fluent Explorer, **Ctrl+V** → file pastes in.
- [ ] Copy a file in Fluent (Ctrl+C), paste in **Nemo** → file appears.
- [ ] Cut (Ctrl+X) in Fluent, paste elsewhere → original is moved (trashed) only after a confirmed copy.
- [ ] Filenames with spaces / unicode round-trip correctly.

## 4. Drag and drop (reworked — most important to test)
- [ ] **Internal move**: drag a file onto a folder tile inside the app → it moves into that folder.
- [ ] Hold **Ctrl** while dragging onto a folder → it copies instead of moving.
- [ ] Drag a multi-selection onto a folder → all selected items move.
- [ ] A plain click still selects; a double-click still opens (drag only starts after ~6px of movement).
- [ ] **Drag OUT**: drag a file and release it on the desktop / a Nemo window → it copies out
      (native drag kicks in once the pointer leaves the window).
- [ ] **Drop IN**: drag a file from Nemo/desktop into the file list → copies into current folder.
- [ ] Drop a file onto the toolbar/sidebar → nothing breaks (no more "window navigates to file://" blank-out).

## 5. Render speed (large folders)
- [ ] Open a folder with thousands of images. Scrolling should stay smooth; thumbnails load as they
      come into view (~400px before). RAM stays bounded.
- [ ] Selection, rubber-band drag-select, and Ctrl+A still work across the folder.

## 6. Split view (v1.6 — verified structurally in a browser, confirm UX on Linux)
- [ ] Click **⊟⊟ Split** in the toolbar → a second pane opens on the right at Home; the focused
      pane has an accent left-border and each pane shows its folder path in a slim header.
- [ ] Click a tab → it loads into the **focused** pane. Click/F6 to switch which pane is focused;
      the toolbar, address bar, and sidebar follow the focused pane.
- [ ] Each pane navigates independently (double-click folders in either) and can have its own
      sort/view mode.
- [ ] **Drag a file from one pane onto the other pane** (empty area → its folder; onto a folder tile
      → into it). Move by default, Ctrl = copy.
- [ ] **Copy in pane A (Ctrl+C), focus pane B, paste (Ctrl+V)** → file lands in pane B's folder.
      Same for Cut (Ctrl+X).
- [ ] Click **⊟⊟ Split** again → collapses back to a single pane; the other tab stays in the tab bar.
- [ ] Relaunch → split state and both panes' folders are restored.

## 7. v1.6.1 bug fixes (confirm on Linux)
- [ ] Open a folder with **many images/videos** → thumbnails load as you scroll (the `loading="lazy"`
      regression that blocked `localthumb://` fetches is removed).
- [ ] Press **Ctrl+R** (or Cmd+R) in a folder → it **refreshes the current folder in place**, does
      NOT reload the app or jump to Home. Scroll position is kept. Works in both panes when split.
- [ ] Quit and relaunch → you land back on the folders you had open (session is saved on navigation).

## If something regresses
The changes are grouped by area (history, SMB, clipboard, drag, render). The drag rework in
`explorer.html` is the riskiest piece and is self-contained in the "INTERNAL DRAG" section — if it
misbehaves it can be reverted on its own. Nothing here is committed yet; commit when you're happy.
