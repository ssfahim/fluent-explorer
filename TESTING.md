# v1.5 Testing Checklist (run on the Linux PC)

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

## If something regresses
The changes are grouped by area (history, SMB, clipboard, drag, render). The drag rework in
`explorer.html` is the riskiest piece and is self-contained in the "INTERNAL DRAG" section — if it
misbehaves it can be reverted on its own. Nothing here is committed yet; commit when you're happy.
