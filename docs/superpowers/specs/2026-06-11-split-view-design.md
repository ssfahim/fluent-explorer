# Split View (dual-pane) — design

Date: 2026-06-11
Component: `explorer.html` (renderer only; no main-process changes)

## Goal
Let the file manager show two folders side-by-side so files can be dragged, copied/cut,
and pasted between them within the app. Shared tab bar, vertical (left/right) split.

## Model
- `tabs[]` stays the shared pool of open tabs (each = folder + history + selection + view state).
- New `panes` array, 1 or 2 entries. Each pane: `{ tabId, el, hdrEl, io, imgMap, pending, flushTmr }`
  where `el` is the pane's own scrollable `.content` div.
- `focusedPaneIdx` (0/1). `ct()` returns the focused pane's tab, so existing toolbar / keyboard /
  clipboard / address-bar code keeps working — it just acts on the focused pane.
- `splitOn` boolean. Off → only pane 0 (today's behavior). On → two panes + divider; the right
  pane opens a new tab at Home.

## Focus model (the linchpin)
A capture-phase `mousedown` on the panes container sets `focusedPaneIdx` to whichever pane was
clicked, *before* any tile's inline `onclick`/`ondblclick` runs. Because those inline handlers use
`ct()`, they automatically act on the just-focused pane. This avoids changing inline handler or
`nav()` signatures. `F6` also toggles focus.

## Per-pane vs shared
- Per-pane DOM + its own IntersectionObserver, rubber-band scope, and drag source.
- Per-tab view state (moved off globals): `vm`, `sortBy`, `sortAsc`, `groupBy`. Each pane sorts/views
  independently.
- Shared, reflecting the focused pane: toolbar, address bar (back/fwd/breadcrumb/search), status bar,
  sidebar highlight, window title. `iconSize` + theme stay global (both panes match).
- Each pane shows a slim header with its folder path (only visible when split is on) so it's clear
  which pane is where; focused pane gets an accent left-border.

## Cross-pane operations
- **Drag-drop**: the existing mouse-emulated drag is document-level. On drop, resolve the destination
  from `elementFromPoint`: a folder tile → into it; otherwise the pane under the cursor → that pane's
  current folder. Works within a pane and across panes. Move by default, Ctrl = copy. Pointer leaving
  the window still escalates to a native OS drag-out.
- **Copy/cut/paste**: Ctrl+C/X act on the focused pane's selection (global clipboard); focus the other
  pane and Ctrl+V pastes into its folder. No new clipboard logic.

## Functions becoming pane/tab-aware
`buildContent(pane)`, `loadDir(pane)`, `filterEnt(pane)`, `sortEnt(tab)`, `loadFolderSort(tab)`,
`observeThumbs(pane)`, `flushThumbs(pane)`, `syncSelectionCSS(pane)`. `nav/doSort/setVM/setSortCol/
sel/goBack/goFwd/goUp` operate on the focused pane (unchanged signatures). `thumbCache` stays global
(same file → same thumbnail).

## Tab bar behavior
- Highlights the focused pane's tab; the other pane's tab gets a subtle marker.
- Clicking a tab loads it into the focused pane; if it's currently in the other pane, the two panes
  swap so a folder never shows in both panes at once.
- `+` adds a tab into the focused pane. Closing a tab shown in a pane moves that pane to another tab.

## Persistence
Session saves `{ tabs:[paths], split:bool, panes:[tabIndex,...] }`. Old sessions (tabs only) still load.

## Risk / non-goals
- No per-pane independent tab strips (rejected option B). No resizable divider in v1 (50/50 split).
- Big untestable-on-macOS refactor; split-off path must behave exactly as today to contain risk.
</content>
