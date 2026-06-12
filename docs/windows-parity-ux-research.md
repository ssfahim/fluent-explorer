# Windows 11 Experience Parity — UX Research

**Goal:** Make a long-time Windows user forget they are on Linux.
**Scope:** *Experience* parity (feel, timing, motion, muscle memory) — **not** feature parity.
**Targets:** Windows 11 **File Explorer** + **Windows Photos**, recreated in Electron 28.

> This document is a research + design reference. Each finding answers five questions:
> **(1)** What exactly does Windows do? **(2)** Why does it feel good? **(3)** How to recreate it in Electron?
> **(4)** Libraries/APIs to use. **(5)** Pitfalls to avoid.
> Where relevant, a **Current state** line notes what `fluent-explorer` already does (`main.js`, `explorer.html`, `photos.html`).

---

## The core principle: feel is timing, not features

A Windows user doesn't consciously notice features — they notice **latency, motion curves, and the absence of jank**. Three numbers govern almost everything below:

- **100 ms** — the threshold under which an action feels *instant*. Selection, hover, click feedback must land here.
- **~250 ms** — Fluent's standard transition window. Long enough to read as motion, short enough not to feel slow.
- **1 s** — the threshold above which a user needs *progress feedback* or they assume the app froze.

Windows' "Fluent" motion system is built on these. The single most important easing curve to internalize:

```
/* WinUI "standard decelerate" — the Windows default for things entering/settling */
cubic-bezier(0.1, 0.9, 0.2, 1.0)

/* "Fast out" / accelerate — for things leaving */
cubic-bezier(0.7, 0.0, 1.0, 0.5)

/* Point-to-point (UI moving between two states) */
cubic-bezier(0.55, 0.55, 0.0, 1.0)
```

Linear easing is the #1 tell that an app "isn't Windows." Almost nothing in Fluent is linear.

---

## 1. Animations & Transitions

**1. What Windows does.** Win11 motion is deliberately *small and fast*. Context menus and flyouts **fade + scale** from 95%→100% over ~150 ms with the decelerate curve. Tab strip uses connected/reposition animations (~250 ms). Window content uses subtle "page" transitions. Hover states cross-fade over ~80–100 ms. The list itself does *not* animate item reflow (no spring physics) — Explorer keeps the file grid static and cheap; motion is reserved for chrome (menus, tabs, panes, the address bar progress sliver).

**2. Why it feels good.** Motion is *informational, not decorative* — it tells you where a thing came from (menu grows from the click point) and where focus went (tab slides in). Because it's short and decelerating, it reads as "the UI is responding to me" rather than "the UI is putting on a show."

**3. Recreate in Electron.** Pure CSS transitions/animations on `transform` and `opacity` only (compositor-friendly). Set `transform-origin` to the invocation point for menus so they grow toward the cursor. Reserve motion for chrome; keep the file list static.

```css
.menu { animation: menu-in .15s cubic-bezier(0.1,0.9,0.2,1.0); transform-origin: var(--ox) var(--oy); }
@keyframes menu-in { from { opacity:0; transform:scale(.96) } to { opacity:1; transform:none } }
.row, .btn { transition: background-color .09s ease-out; }
```

**4. Libraries/APIs.** None needed — CSS. For complex sequenced motion (split-view divider, pane open/close) use the **Web Animations API** (`element.animate()`) so you can await `.finished`. Respect `@media (prefers-reduced-motion: reduce)`.

**5. Pitfalls.** (a) Animating `width`/`height`/`top`/`left` → layout thrash; only animate `transform`/`opacity`. (b) Linear easing. (c) Durations > 300 ms feel sluggish. (d) Animating the file list on every folder change — Windows doesn't, and it makes large folders stutter. (e) Forgetting `transform-origin` so menus appear to "zoom from the corner."

**Current state.** Context menu already does `.08s` scale(0.95→1)+opacity (`explorer.html:84`); button hovers `.08s`; Photos chrome auto-hide `.2s`. Good. **Gap:** no `transform-origin` at cursor, no tab connected-animation, no reduced-motion guard.

---

## 2. Timing (debounce, delays, thresholds)

**1. What Windows does.** Explorer is full of invisible timing rules. A folder that loads fast shows **no spinner at all** — the green address-bar progress sliver only appears after ~**500–800 ms** of waiting. Type-ahead search buffer resets after ~**1 s** of no keystrokes. Thumbnails generate on a background queue and pop in asynchronously. Tooltips appear after ~**500 ms** hover. Double-click window is the OS `GetDoubleClickTime()` (default **500 ms**).

**2. Why it feels good.** The "delay the spinner" trick is the single biggest perceived-performance win: showing a spinner for a 120 ms operation makes it *feel slower* (the eye registers the spinner, not the result). Suppressing feedback for fast ops makes the app feel instant; showing it only when genuinely slow makes waits feel acknowledged.

**3. Recreate in Electron.** Centralize timing constants. Gate every loading indicator behind a delay timer that you *cancel* if the work finishes first:

```js
let spin; const show = () => spin = setTimeout(renderSpinner, 600);
load().finally(() => { clearTimeout(spin); hideSpinner(); });
```

Debounce search input ~150–200 ms; debounce session-save ~600 ms; type-ahead reset ~900 ms–1 s.

**4. Libraries/APIs.** `setTimeout`/`clearTimeout`; a tiny `debounce`/`throttle` (don't pull in lodash for two functions). `requestIdleCallback` for non-urgent work (thumbnail prefetch).

**5. Pitfalls.** (a) Spinner with no delay → flicker on fast loads. (b) Debounce too long → input feels laggy (>250 ms is noticeable). (c) Hard-coding double-click time instead of feeling natural (~250–500 ms). (d) Not cancelling timers on navigation → stale spinners.

**Current state.** Already strong: 600 ms session debounce, 80 ms thumb-batch flush, 900 ms type-ahead, 220 ms filmstrip rebuild, paginated 50/100 ms (`explorer.html`). **Gap:** search filter has *no* debounce (instant `.includes()` — fine for current-folder, but add the delayed-spinner pattern for slow/recursive cases).

---

## 3. Keyboard Shortcuts

**1. What Windows does.** The canonical Explorer set (these are muscle memory and *must* match exactly):

| Key | Action | Key | Action |
|---|---|---|---|
| `Ctrl+C/X/V` | Copy/Cut/Paste | `Alt+←/→` | Back/Forward |
| `Ctrl+A` | Select all | `Alt+↑` | Up one level |
| `Ctrl+T` | New tab | `Backspace` | Back |
| `Ctrl+W` | Close tab | `F2` | Rename |
| `Ctrl+N` | New window | `F3` | Search |
| `Ctrl+Shift+N` | New folder | `F5` | Refresh |
| `Ctrl+L` / `Alt+D` / `F4` | Focus address bar | `F11` | Fullscreen |
| `Ctrl+F` / `Ctrl+E` | Search box | `Delete` | Recycle Bin |
| `Ctrl+Shift+E` | Expand nav tree | `Shift+Delete` | Permanent delete |
| `Ctrl+1..8` | Switch view (icons/list/details…) | `Ctrl+Shift+1..8` | Same | 
| `Enter` | Open | `Ctrl+Mouse-wheel` | Cycle view size |
| `Alt+Enter` | Properties | `Ctrl+Shift+Tab`/`Ctrl+Tab` | Prev/next tab |

Photos: `←/→` navigate, `+/-`/`Ctrl+wheel` zoom, `Ctrl+0` fit, `Ctrl+R` rotate, `F5` slideshow, `Delete` delete, `Esc` close, `Ctrl+P` print, `Ctrl+C` copy.

**2. Why it feels good.** Power users navigate Explorer almost entirely by keyboard. A single missing or wrong binding (e.g. `Backspace` not going back) breaks flow and immediately signals "this isn't Explorer."

**3. Recreate in Electron.** A central `keydown` handler in the renderer for in-app shortcuts; use Electron **`globalShortcut`** only for truly global ones (avoid — it steals from the whole OS). For menu-bar accelerators use the **`Menu`/`MenuItem` accelerator** property so they show in menus *and* work. Match `Alt+Enter` → Properties, `Ctrl+Mouse-wheel` → view-size cycling.

**4. Libraries/APIs.** Electron `Menu` accelerators, `before-input-event` on `webContents` (lets main intercept before the page). Keep a single source-of-truth keymap object.

**5. Pitfalls.** (a) `globalShortcut` hijacking system-wide. (b) Forgetting `Backspace`=Back and `Alt+Enter`=Properties (commonly missed). (c) Not pre-selecting the **filename stem** (without extension) on `F2`. (d) Letting browser defaults fire (`Ctrl+F` opening a find bar) — call `preventDefault`. (e) Linux WM eating `F11`/`Alt+F4` — handle gracefully.

**Current state.** 26+ shortcuts implemented including `F2` stem-preselect, type-ahead. **Gap:** `Ctrl+1..8` view switching, `Alt+Enter` properties, `F3` search, `Ctrl+N` new window, `Ctrl+Tab` tab cycling.

---

## 4. Mouse Interactions

**1. What Windows does.** Default is **double-click to open, single-click to select** (with an option for single-click-open + hover-select). Hover highlights the row with a subtle tint after a near-zero delay. Right-click selects the item *then* opens the context menu. Middle-click on a folder opens it in a new tab. Hovering a file shows a tooltip (~500 ms) with metadata. The selection rectangle (marquee) starts only after a small drag threshold so a sloppy click doesn't start a drag.

**2. Why it feels good.** The drag threshold (~4–6 px) is critical: it means clicking never accidentally drags, and dragging never accidentally just clicks. Hover tint gives continuous spatial feedback. Right-click-selects-first means the menu always acts on what you right-clicked, never a stale selection.

**3. Recreate in Electron.** Track `mousedown`→`mousemove` distance; only enter drag mode past ~6 px. On `contextmenu`, if the target isn't in the current selection, select it first. Wire **middle-click** (`auxclick`, button 1) → open-in-new-tab. Add hover tooltips with a 500 ms delay.

**4. Libraries/APIs.** DOM pointer events (`pointerdown/move/up` — unifies mouse/touch). `auxclick` for middle button. Avoid heavy gesture libs for this.

**5. Pitfalls.** (a) No drag threshold → clicks become micro-drags. (b) Context menu acting on the old selection. (c) Using `dblclick` exclusively and missing the single-click-select feedback. (d) Native browser text-selection firing during marquee — set `user-select: none` on the file area.

**Current state.** Single/ctrl/shift click, 6 px drag threshold, hover `.hv`, right-click menu all present. **Gap:** middle-click→new-tab, hover tooltips, right-click-selects-first verification.

---

## 5. Selection Behavior

**1. What Windows does.** Click = select one. `Ctrl+Click` = toggle one. `Shift+Click` = range from anchor. `Ctrl+Shift+Click` = add a range. **Marquee** (rubber-band): drag on empty space draws a translucent blue rectangle; items intersecting it select live as you drag; holding `Ctrl` during marquee *adds* to existing selection. `Ctrl+A` = all. Arrow keys move a **focus cursor** (dotted outline) distinct from selection; `Shift+Arrow` extends; `Ctrl+Arrow`+`Space` toggles individual items. `Space` toggles the focused item.

**2. Why it feels good.** The **anchor + focus-cursor model** is what makes shift-selection predictable: the range is always anchor→current, and `Ctrl+Space` lets you cherry-pick without losing the cursor. Live marquee feedback (selecting as you drag, not on release) feels direct and physical.

**3. Recreate in Electron.** Maintain three pieces of state: `selection: Set`, `anchorIndex`, `focusIndex`. Implement the marquee as an absolutely-positioned div; on each `mousemove` compute intersection with item rects (cache `getBoundingClientRect`s once at drag-start, not per-frame). Toggle a `.sel` class only — never re-render the list.

**4. Libraries/APIs.** Plain DOM + a cached rect array. `requestAnimationFrame` to coalesce marquee updates. For huge folders, hit-test against the *virtualized* item model, not DOM nodes.

**5. Pitfalls.** (a) Conflating focus-cursor with selection (breaks `Ctrl+Arrow`+`Space`). (b) Recomputing rects every mousemove → jank. (c) Marquee not respecting `Ctrl` for additive select. (d) Losing the anchor after a `Ctrl+Click` (Windows moves the anchor to the ctrl-clicked item). (e) Re-rendering the list on selection change instead of toggling a class.

**Current state.** Click/ctrl/shift, marquee scoped per-pane, `Shift+Home/End`, `Ctrl+A`, class-toggle (no re-render). Strong. **Gap:** explicit focus-cursor separate from selection; `Ctrl+Space` toggle; additive marquee with `Ctrl`.

---

## 6. Context Menus

**1. What Windows does.** Win11 introduced the **compact rounded acrylic menu** with the most-common actions as an **icon strip at the top** (Cut/Copy/Rename/Share/Delete), then labeled items, then "Show more options" → the legacy full menu. It fades+scales in (~150 ms) from the cursor, repositions to stay on-screen (flips up/left near edges), supports submenu fly-outs with a hover delay (~300 ms, with the "diagonal triangle" forgiveness so moving toward a submenu doesn't close it). Keyboard: `Menu` key / `Shift+F10` opens it, arrows navigate, letters jump to mnemonics.

**2. Why it feels good.** The icon strip puts the 5 actions you use 90% of the time one click away. The submenu triangle-forgiveness prevents the rage of a submenu snapping shut when your cursor cuts a corner. Edge-flipping means it's never clipped.

**3. Recreate in Electron.** Build a **custom HTML menu** (Electron's native `Menu` can't do the icon strip / acrylic). Position with viewport-clamp logic. Implement submenu open-delay + a "safe triangle" between cursor and submenu. Open on `contextmenu` and `Shift+F10`. Use `backdrop-filter: blur()` for acrylic.

**4. Libraries/APIs.** Custom DOM. (Native `Menu.popup()` only if you want OS-native look — but then you lose the Win11 strip.) `backdrop-filter` for acrylic; provide a solid fallback for transparency-disabled WMs.

**5. Pitfalls.** (a) Menu clipped at screen edge — must flip. (b) Submenus that close on diagonal cursor movement (no safe-triangle). (c) `backdrop-filter` performance / unsupported on some Linux compositors → fallback to opaque. (d) Menu not closing on outside click, `Esc`, blur, or scroll. (e) No keyboard navigation.

**Current state.** Custom 15-item menu, viewport-positioned, closes on outside mousedown (`explorer.html`). **Gap:** Win11 icon strip, acrylic blur, submenu safe-triangle, `Shift+F10`, arrow-key navigation.

---

## 7. Window Management

**1. What Windows does.** Each Explorer window is independent; **tabs** live inside a window (Win11 22H2+) with drag-to-reorder and tear-off to a new window. **Snap Layouts**: hovering the maximize button (or `Win+Z`) shows a grid of layout zones; `Win+←/→/↑/↓` snaps to halves/quarters. Windows remember size, position, *and monitor*. Maximize/restore animate (~200 ms). Title bar is part of the Mica-tinted chrome.

**2. Why it feels good.** Snap is core to Windows multitasking muscle memory. Tab tear-off and reorder match browser expectations. Restoring to the exact prior monitor+size means the app "remembers where it was."

**3. Recreate in Electron.** `BrowserWindow` per window; persist bounds via `getBounds()`/`setBounds()` keyed by display. For tabs, build them in the renderer (Electron has no native tab UI) with drag-reorder and tear-off (create a new `BrowserWindow`, transfer tab state via IPC). Snap is **the WM's job on Linux** — don't fight it; ensure the window is a normal resizable top-level so Mint's Muffin/Cinnamon snapping (drag-to-edge, `Super+arrows`) just works. Use `frame: false` + custom title bar only if you want Mica look, else keep native frame for free WM integration.

**4. Libraries/APIs.** `BrowserWindow`, `screen` module (display geometry), `electron-window-state` or hand-rolled bounds persistence. `app.on('second-instance')` to focus existing window / open new tab instead of a new process.

**5. Pitfalls.** (a) Restoring bounds onto a now-disconnected monitor → window off-screen (clamp to current `screen` displays). (b) Frameless windows breaking Linux WM snapping and tiling. (c) Re-implementing snap in JS (don't — Cinnamon/KWin/GNOME already do it). (d) Tab tear-off losing scroll/selection state. (e) Single-instance not handled → multiple processes.

**Current state.** Two windows (Explorer+Photos), tabs within Explorer, split-view, session restore of tabs+split. **Gap:** tab reorder/tear-off, per-monitor bounds persistence, off-screen clamp.

---

## 8. Navigation Patterns

**1. What Windows does.** Per-tab **Back/Forward with history stacks** (and a dropdown of recent locations on long-press/click-hold of the arrow). **Up** goes to parent. The address bar is a **breadcrumb by default**, click-to-edit into a text path. Navigating preserves and **restores scroll position** when going Back. Typing a path or `shell:` command (e.g. `shell:downloads`) navigates. `Recent`, `Quick Access`, `This PC`, `Network` are nav-tree roots.

**2. Why it feels good.** Back restoring scroll position is a huge "it remembered" moment. The breadcrumb-that-becomes-a-textbox gives both quick jumping and power-user path entry without a mode switch. History dropdown saves repeated Back clicks.

**3. Recreate in Electron.** Per-tab `{hist: [], hi: index}`. Back/Forward splice the stack; preserve `scrollTop` per history entry and restore on navigation. Breadcrumb renders path components; clicking the empty area or `Ctrl+L` swaps to an `<input>`. Support `~`, env vars, and friendly aliases.

**4. Libraries/APIs.** Plain JS state; `fs` via IPC for path resolution/validation. Debounce nothing here — navigation should be instant.

**5. Pitfalls.** (a) Not restoring scroll on Back. (b) History shared across tabs. (c) Breadcrumb not handling very long paths (need overflow chevron / ellipsis with a dropdown). (d) Address-bar edit mode not reverting on `Esc`. (e) Forward stack not cleared when navigating to a new path mid-history.

**Current state.** Per-tab history+index, Back/Forward/Up with disabled states, breadcrumb, click-to-edit address bar, **per-folder scroll restore**. Excellent — this is core parity. **Gap:** history dropdown on arrow long-press, long-path overflow handling.

---

## 9. Perceived Performance Tricks

**1. What Windows does.** Explorer renders the **folder chrome and any cached items instantly**, then fills in thumbnails asynchronously (generic file-type icon first, real thumbnail fades in). It shows the **green progress sliver in the address bar** only for slow folders. Selection, hover, and view-switching are *always* instant because they're pure UI. It reuses the **thumbnail cache** so revisited folders appear fully-rendered immediately.

**2. Why it feels good.** The app always responds to *input* in <100 ms even when the *data* is slow. The user's action (click, select, scroll) is never blocked on I/O. Cached revisits feel like the folder was "already open."

**3. Recreate in Electron.** Decouple input handling from I/O: render the list skeleton from `readdir` (cheap) before any `stat`/thumbnail work; do `stat` in a parallel pool; stream thumbnails in. Keep selection/hover/sort as pure DOM ops. Cache aggressively (memory + disk). Prefetch next/prev in Photos. Use **optimistic UI** for rename/move (update the DOM immediately, reconcile on IPC reply, roll back on error).

**4. Libraries/APIs.** `IntersectionObserver` (load only visible thumbnails), `content-visibility: auto` (skip offscreen layout), `requestIdleCallback` (prefetch), worker threads / large libuv pool for `stat`. `createImageBitmap` to decode off the main thread.

**5. Pitfalls.** (a) Blocking the first paint on `stat`-ing every file. (b) No disk thumbnail cache → cold every launch. (c) Optimistic UI with no rollback on failure. (d) Loading all thumbnails, not just visible. (e) Synchronous `fs.*Sync` on the main process freezing all windows.

**Current state.** Best-in-class here: 3-tier thumb cache, IntersectionObserver (+400 px margin), `content-visibility`, 64-thread stat pool, serialized Photos decode, GIF prefetch, instant CSS selection. **Gap:** thumbnail **fade-in/pop** animation (Windows fades thumbs in — currently they appear hard); generic-icon-then-thumbnail placeholder; optimistic rename rollback.

---

## 10. Thumbnail Loading Behavior

**1. What Windows does.** A central **thumbnail cache** (`thumbcache_*.db`) stores multiple sizes. On folder open, items show a **generic type icon immediately**, then the real thumbnail **fades in** as the background `IThumbnailProvider` produces it (top-to-bottom, prioritizing visible items). Thumbnails are sized to the current view (32/96/256/1024). Scrolling fast doesn't generate thumbnails for items you scroll past — it prioritizes what stops on screen.

**2. Why it feels good.** Nothing ever blocks: you see *something* (the icon) instantly, and the picture "develops" in. Fast-scroll doesn't choke because it abandons offscreen work. The fade-in masks the async nature so it reads as polish, not loading.

**3. Recreate in Electron.** Generate with **sharp/libvips** in the main process (worker-backed), cache to disk keyed by `path+mtime+size` (SHA-256), and to memory. Serve via a custom protocol (`localthumb:`) not data-URIs. Show a generic icon, then swap with a CSS opacity fade on load. Use `IntersectionObserver` to enqueue only visible items; **cancel/deprioritize** when they scroll out before generation. Use `nativeImage` as a fallback decoder.

**4. Libraries/APIs.** `sharp` (^0.34), Electron `nativeImage`, `protocol.handle()` custom scheme, `IntersectionObserver`, `ffmpeg` (video frame), `mtime`-based cache keys. Worker threads for CPU-bound resize if sharp's internal pool isn't enough.

**5. Pitfalls.** (a) data-URI thumbnails (bloat the DOM, no caching, GC churn) — use a protocol. (b) Cache key without `mtime` → stale thumbnails after edits. (c) Decoding full-res then downscaling in the renderer → OOM (the documented crash cause here). (d) No fade → "pop-in" feels cheap. (e) Generating for fast-scrolled-past items → wasted CPU. (f) Unbounded in-flight concurrency → thrash; cap the batch (this app uses 30).

**Current state.** Sharp 200px + nativeImage fallback, broken-libvips probe, 3-tier cache (SHA-256/disk), `localthumb:` protocol, IntersectionObserver, 30-batch cap, ffmpeg video frames, request-ID staleness guard. Very thorough. **Gap:** generic-icon placeholder + **fade-in** on load; size thumbnails to the active view (currently fixed 200px); cancel generation for scrolled-past items.

---

## 11. Folder Loading Behavior

**1. What Windows does.** Reads the directory and shows items progressively — **chunks appear as they're enumerated** rather than waiting for the whole folder. Huge folders (100k+ files) stay scrollable because the list is virtualized. Sort/group are computed and applied without a full reload. The **column auto-detection** (Pictures→large icons+date; Music→details) adapts the view to content type. Slow/network folders show the green progress bar and remain interactive.

**2. Why it feels good.** Even a 50k-file folder feels responsive because you see and can scroll the first chunk in <300 ms, and the view "knows" what kind of folder it is (photos as a grid, docs as a list).

**3. Recreate in Electron.** `readdir` first (fast), render a virtualized list immediately, then `stat` in a parallel pool and patch rows in place. Paginate enumeration for very large folders. Apply content-type heuristics (folder name + extension histogram) to pick default view + sort. Natural-sort names.

**4. Libraries/APIs.** `fs.opendir`/`readdir({withFileTypes})`, a large `UV_THREADPOOL_SIZE`, `Intl.Collator({numeric:true})` for natural sort, `content-visibility`/virtual list for rendering. Per-stat timeout for network mounts.

**5. Pitfalls.** (a) `stat`-ing every entry before first paint. (b) Full re-render on sort instead of re-ordering DOM. (c) Default `UV_THREADPOOL_SIZE` (4) bottlenecking network stat. (d) No per-file timeout → one dead SMB handle hangs the whole folder. (e) Non-natural sort ("file10" before "file2").

**Current state.** Paginated 500-item chunks, 64-thread parallel stat with 5 s per-stat timeout, natural sort, content-aware defaults (Pictures/Downloads→newest), group-by type/date, `content-visibility` virtualization. Excellent. **Gap:** progressive *enumeration* streaming (currently chunks after full readdir); true windowed virtualization for 100k+ (content-visibility helps layout but DOM nodes still exist).

---

## 12. Error Handling

**1. What Windows does.** Permission-denied shows an inline "You don't currently have permission to access this folder" with a **Continue** (elevate) button. File-in-use shows which process holds it. Copy conflicts → the rich **Replace / Skip / Compare info** dialog. Network loss → "Location is not available" with **Retry**. Errors are **specific and actionable**, never a raw error code, and never crash the window.

**2. Why it feels good.** Every error tells you *what* failed and *what you can do next*. The Continue-to-elevate flow turns a dead-end into one click. Conflicts show file sizes/dates so you decide knowingly.

**3. Recreate in Electron.** Catch IPC errors and map errno/stderr → friendly messages + an action (Retry, Elevate via `pkexec`, Open-as-admin). Never let an unhandled rejection bubble. Use a consistent inline error band in the file area (not just modal alerts). For conflicts, show name/size/mtime of both sides with Replace/Skip/Keep-both.

**4. Libraries/APIs.** Node `errno` codes (`EACCES`, `ENOENT`, `EBUSY`, `ETIMEDOUT`), `pkexec`/`polkit` for elevation, Electron `dialog` for modal conflicts, a toast system for transient errors. `process.on('uncaughtException')`/`unhandledRejection` as a last-resort logger.

**5. Pitfalls.** (a) Showing raw errno to users. (b) Modal alert for every transient hiccup (use toasts). (c) No Retry on network errors. (d) Errors that take down the renderer. (e) Swallowing errors silently → user thinks it worked.

**Current state.** SMB errors classified (auth/denied/noshare/offline/proto) with friendly text + password refocus; copy conflict Skip/Replace/Keep-both; crash logging. Good foundation. **Gap:** inline permission band + Continue/elevate; **Retry** on network loss; toast system for transient ops; replace-dialog showing both files' size/date.

---

## 13. Search Experience

**1. What Windows does.** Two tiers: **indexed locations** (Documents, Pictures, etc. via Windows Search service) return results **instantly as you type**, ranked, with content matches. **Non-indexed/network** locations do a **live recursive crawl** showing the green progress bar and streaming results in. Search scope is the current folder + subfolders. Supports filters (`kind:`, `date:`, `size:`, `*` wildcards). Results show the containing path. Search box clears on navigation.

**2. Why it feels good.** Indexed search feels *psychic* — results before you finish typing. The streaming crawl for everything else means you're never staring at a blank screen wondering if it's working. Path-in-results lets you find *where* something is.

**3. Recreate in Electron.** Current-folder filter = instant client-side `includes` (debounce ~150 ms). Recursive search = a **streaming walker** in the main process that emits matches over IPC as it finds them (don't await the whole walk); show the progress sliver; cap/throttle result emission. Consider a background **index** (SQLite FTS) of frequently-visited trees for the "instant" tier. Parse simple filter tokens.

**4. Libraries/APIs.** `fs.opendir` recursive walk in a worker; IPC streaming (`webContents.send` per batch); optionally **`better-sqlite3` + FTS5** for an index; `Intl` for case/diacritic-insensitive matching. Cancellation via an `AbortController` token per search.

**5. Pitfalls.** (a) Awaiting a full recursive walk before showing anything → feels frozen on big trees. (b) No cancellation when the user edits the query → old crawl floods results. (c) Searching network shares without a timeout. (d) Blocking the renderer with a synchronous walk. (e) No debounce → a walk kicked off per keystroke.

**Current state.** Current-folder live filter (case-insensitive, no debounce), Photos "Scan Subfolders". **Gap (biggest in the app):** no recursive Explorer search, no streaming results, no progress feedback, no cancellation, no filter tokens, no index tier.

---

## 14. SMB / Network Share Experience

**1. What Windows does.** `\\server\share` in the address bar **just connects** — credential prompt with "Remember my credentials," then it mounts transparently and browses like a local folder. **Map Network Drive** assigns a letter. Network discovery shows machines under **Network**. Reconnects mapped drives at login. Offline servers show a clear "not available + Retry." Browsing feels local because of aggressive metadata caching and read-ahead.

**2. Why it feels good.** Zero ceremony: type the path, enter credentials once, and it behaves exactly like a local folder — same selection, thumbnails, drag-drop. Credential persistence means it's a one-time cost.

**3. Recreate in Electron.** Kernel **`mount.cifs`** (via `pkexec`) for performance with tuned options (`cache=loose`, `actimeo`, 1 MB rsize/wsize), GVFS/`gio` as no-sudo fallback. Pre-flight TCP probe (445/139) + `smbclient` auth probe for precise errors. Store credentials in the **OS keyring** (libsecret) with a "remember" toggle. Discover hosts via `avahi-browse`. Apply per-stat timeouts so a dropped share never hangs the UI.

**4. Libraries/APIs.** `mount.cifs`/`cifs-utils`, `gio`/GVFS, `smbclient`, `avahi-browse`, `pkexec`/polkit, **`keytar`/libsecret** for credentials, larger `UV_THREADPOOL_SIZE`. Convert `\\server\share` UNC input to the mount path transparently.

**5. Pitfalls.** (a) Credentials in argv (visible in `ps`) — use a 600-mode creds file or stdin. (b) No per-op timeout → dead share freezes the app. (c) Synchronous stat on network paths. (d) Not caching metadata → painfully slow listing. (e) Forcing a single SMB dialect (negotiate 3.1.1→3.0→2.1). (f) Storing passwords in plaintext config instead of the keyring.

**Current state.** Outstanding: mount.cifs with dialect negotiation + tuned options + 600-mode creds file, GVFS fallback, TCP+smbclient probes, NT_STATUS→friendly mapping, avahi LAN scan, 5 s stat timeouts. **Gap:** OS-keyring credential persistence ("remember"), UNC `\\` address-bar input auto-mount, drive-letter-style favorites.

---

## 15. Drag and Drop

**1. What Windows does.** Drag shows a **ghost preview** of the dragged item(s) with a count badge ("3 items") and a **cursor cue** indicating the operation: **Move** (no badge, same drive), **Copy** (+ badge, cross-drive or `Ctrl`), **Create Link** (`Alt`/`Ctrl+Shift`). Drop targets highlight. Drag onto a folder = into it; onto empty = current folder. Spring-loaded folders: hover over a folder mid-drag ~1 s and it opens. Drag to other apps (e.g. into an email) works system-wide. `Esc` cancels mid-drag.

**2. Why it feels good.** The operation cue removes all doubt about move-vs-copy *before* you drop. The count badge confirms what you grabbed. Spring-loading lets you drill into folders without dropping first.

**3. Recreate in Electron.** Internal DnD: custom pointer state machine (6 px threshold), a floating ghost element following the cursor with a count badge, target `.dragover` highlight, `Ctrl`=copy modifier reflected in the cursor/ghost. Drag-*out* to other apps: Electron **`webContents.startDrag({file/files, icon})`** when the pointer leaves the window. Implement spring-loaded open on ~1 s folder hover. `Esc` aborts.

**4. Libraries/APIs.** Pointer Events for internal; Electron **`startDrag`** for native drag-out (needs a real icon `nativeImage`); HTML5 `dragenter/over/drop` for drag-*in* from other apps + `e.dataTransfer.files`. On Linux this is X11 XDND — works under XWayland, flakier on native Wayland.

**5. Pitfalls.** (a) No operation cue → users unsure if it moved or copied. (b) `startDrag` requires an icon or throws. (c) Wayland native drag-out limitations (test under XWayland). (d) No `Esc` cancel. (e) Ghost element capturing pointer events (set `pointer-events:none`). (f) Not handling multi-item drag when the dragged item is part of a selection.

**Current state.** Internal state machine (6 px threshold), folder `.dov` highlight, `Ctrl`=copy, multi-file, cross-pane, native drag-out via `startDrag` (64 px icon), Photos drop-to-copy with dashed-border feedback. Strong. **Gap:** ghost preview with **count badge** + operation cue; spring-loaded folder open; `Esc` cancel.

---

## 16. Multi-Monitor Behavior

**1. What Windows does.** Windows remember the **monitor** they were last on (not just x/y). Per-monitor **DPI awareness** — drag a window between a 4K and 1080p display and UI rescales crisply. New windows open on the monitor with the cursor / parent window. Maximize stays on the current monitor. Snap zones are per-monitor.

**2. Why it feels good.** "It opens where I left it" across a multi-display desk. No blurry scaling when you move between mismatched-DPI screens. Dialogs appear on the right monitor (the one you're looking at).

**3. Recreate in Electron.** Persist bounds *and* the display id (match via `screen.getDisplayMatching(bounds)` on restore; if that display is gone, clamp to primary). Open child windows/dialogs on the parent's display or `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`. Electron handles per-monitor DPI via Chromium, but verify `zoomFactor`/CSS scale under mixed-DPI on Linux.

**4. Libraries/APIs.** Electron **`screen`** module (`getAllDisplays`, `getDisplayMatching`, `getDisplayNearestPoint`, `getCursorScreenPoint`), `display-added`/`display-removed`/`display-metrics-changed` events. `BrowserWindow.getBounds/setBounds`.

**5. Pitfalls.** (a) Restoring onto a disconnected monitor → invisible window (always validate against current displays). (b) Centering dialogs on primary instead of the active monitor. (c) Ignoring `display-removed` (windows orphaned off-screen). (d) Assuming uniform DPI — Linux mixed-DPI (esp. Wayland fractional scaling) is fragile; test it.

**Current state.** **Not implemented** — single window, no display awareness. **Recommendation:** add the `screen`-keyed bounds persistence + off-screen clamp from §7; open Photos on the cursor's monitor.

---

## 17. Fullscreen Behavior (Photos)

**1. What Windows does.** Photos fullscreen (`F11` / button) hides *all* chrome — only the image, on black. Mouse movement reveals a **slim auto-hiding toolbar** (prev/next/zoom/delete) that fades after ~2–3 s idle. `Esc` exits. Arrow keys navigate within fullscreen. The transition to fullscreen is near-instant; the image stays centered and re-fits to the new bounds.

**2. Why it feels good.** True immersion — nothing but the photo on black. The auto-hiding controls mean they're there when you reach for them but gone when you're just looking. No letterbox jump because it re-fits smoothly.

**3. Recreate in Electron.** `BrowserWindow.setFullScreen(true)` for OS fullscreen; **also** an in-app immersive mode (hide panels via CSS) for a faster toggle. Auto-hide controls on a ~2.6 s idle timer reset on `mousemove`; fade with opacity. Re-compute image fit on `resize`. Sync state both ways (WM `enter/leave-full-screen` events ↔ renderer).

**4. Libraries/APIs.** Electron `win.setFullScreen()` + `enter-full-screen`/`leave-full-screen` events; CSS for immersive; `requestAnimationFrame` for the canvas re-fit. Hide the cursor too (`cursor:none`) when chrome is hidden.

**5. Pitfalls.** (a) Only doing CSS "fake" fullscreen (taskbar still shows) vs only OS fullscreen (slower toggle) — offer both. (b) Not re-fitting the image on resize → wrong scale. (c) Controls that don't reappear on mouse-move. (d) Cursor staying visible over a hidden-chrome photo. (e) Linux WM not honoring `setFullScreen` consistently — handle the event, don't assume.

**Current state.** Full: OS `F11` fullscreen + immersive auto-hide (2.6 s), double-click toggle, `Esc` exit, bottom-bar hide, two-way state sync. Excellent. **Gap:** `cursor:none` when chrome hidden; smooth re-fit transition.

---

## 18. Touchpad Gestures

**1. What Windows does.** On **Precision Touchpads**: two-finger scroll (with momentum/inertia), **pinch-to-zoom** (in Photos and Explorer icon size), two-finger swipe nothing-special in Explorer but pinch resizes icons, three-finger swipe = system task switch (OS-level). Photos: pinch zoom + two-finger pan. Scrolling has **inertial flick** and rubber-band-free smoothness.

**2. Why it feels good.** Pinch-to-zoom on a photo is the single most "native" gesture — its absence is instantly noticeable to laptop users. Inertial scrolling makes long folders feel fluid rather than ratchety.

**3. Recreate in Electron.** Chromium delivers precision-touchpad pinch as `wheel` events with **`ctrlKey:true`** (the standard pinch signal) — listen for that to zoom Photos / resize icons. Two-finger scroll arrives as normal smooth `wheel` events (Chromium adds inertia on supported platforms). For finer control use **Pointer Events** with 2 active pointers to compute pinch distance.

**4. Libraries/APIs.** `wheel` event with `e.ctrlKey` (pinch) and `e.deltaY` (scroll); `PointerEvent` (`pointerdown`/`move` tracking 2 pointers) for true multitouch; `touch-action` CSS to opt into gestures. Avoid heavy gesture libs (hammer.js is largely unmaintained) unless you need complex recognizers.

**5. Pitfalls.** (a) Treating pinch `wheel+ctrl` as a regular zoom-page (Chromium's default `Ctrl+wheel` zooms the whole page — `preventDefault` it and apply your own image zoom). (b) Linux touchpad gesture support under Wayland/libinput varies; test on the actual Mint target. (c) No inertia → scrolling feels cheap (Chromium provides some; don't fight it). (d) Blocking the compositor by doing zoom math synchronously per event.

**Current state.** **Not implemented.** **Recommendation:** the highest-value add for laptop users — wire `wheel`+`ctrlKey` → Photos zoom (and Explorer icon-size) and `preventDefault` Chromium's page-zoom. Photos already has wheel-zoom; just gate the pinch signal.

---

## 19. Zoom Behavior (Photos)

**1. What Windows does.** Photos zooms via `Ctrl+wheel`, `+/-`, the zoom slider, or pinch. Range roughly **fit → ~400%+**. Zoom is **centered on the cursor/pinch point** (the pixel under your finger stays put). Above fit-size, two-finger drag / click-drag **pans**. `Ctrl+0` fits to window; double-click toggles fit↔100%. **Fit vs actual-size** is explicit. Smooth, no quantized jumps.

**2. Why it feels good.** Cursor-anchored zoom is the detail that makes it feel physical — you zoom *into the thing you're looking at*, not the image center. Smooth zoom + pan above 100% lets you inspect detail naturally.

**3. Recreate in Electron.** Render to a canvas (or transform on an `<img>`); on zoom, adjust scale **and** translate so the point under the cursor is invariant: `newOffset = cursor - (cursor - oldOffset) * (newScale/oldScale)`. Wheel/keys/pinch all feed one `setZoom(scale, anchor)`. Clamp scale; enable drag-pan when `scale > fit`. Double-click toggles fit↔100%.

**4. Libraries/APIs.** Canvas 2D (`createImageBitmap` + `drawImage` with computed transform — memory-safe, as this app already does) or CSS `transform: scale()+translate()`. `wheel` for zoom (with `ctrlKey` pinch), Pointer Events for pan. Decode a screen-sized copy (≤2048px) to avoid OOM, full-res only when zoomed in.

**5. Pitfalls.** (a) Zooming around image center instead of cursor (feels wrong immediately). (b) Decoding full-resolution into memory at every zoom → OOM (this app's documented crash; the ≤2048px cached copy is the right fix). (c) No pan when zoomed in. (d) Quantized/janky zoom steps — use smooth ~0.1–0.25 increments and animate. (e) Losing zoom state when navigating images (Windows resets to fit per image — match that).

**Current state.** Fit/Fill buttons, wheel `+0.25`, `+`/`-`/`0` keys, 0.25–5× range, canvas redraw, ≤2048px decode (memory-safe). Good. **Gap:** **cursor-anchored** zoom (currently center-based), drag-to-pan when zoomed, double-click fit↔100%.

---

## 20. Breadcrumb Navigation

**1. What Windows does.** The address bar is a **breadcrumb of clickable segments** separated by chevrons (`>`). Clicking a **segment** navigates there; clicking its **chevron** opens a dropdown of that level's **sibling folders** for lateral jumping. Overflow (deep paths) collapses leading segments into a `«` chevron with a dropdown. Clicking empty space or `F4`/`Ctrl+L` switches to **editable text path** (with autocomplete). On blur/`Esc` it reverts to breadcrumb.

**2. Why it feels good.** The chevron-dropdown is the hidden gem: you can jump to a *sibling* folder without going up-then-down. Click-to-edit gives power users raw path entry without a separate mode. Overflow collapse keeps deep paths usable.

**3. Recreate in Electron.** Render segments from the path; each segment = navigate, each chevron = a dropdown populated by `readdir` of the parent (folders only). On overflow, collapse leading segments into a leading dropdown. Click empty area / `Ctrl+L` → swap to `<input>` with path autocomplete; `Esc`/blur reverts. Natural-sort the dropdown.

**4. Libraries/APIs.** DOM; `fs.readdir` (IPC) for sibling dropdowns + autocomplete; `Intl.Collator` for sorting. Measure with `ResizeObserver` to decide when to collapse.

**5. Pitfalls.** (a) Segments only, no **chevron sibling dropdown** (the most-missed Windows affordance). (b) No overflow handling → deep paths overflow the bar. (c) Edit mode not reverting on `Esc`. (d) No autocomplete in edit mode. (e) Recomputing sibling lists eagerly for every segment instead of on chevron-click.

**Current state.** Clickable segments with `›` separators, current bold, click-to-edit address bar. Solid. **Gap:** chevron **sibling dropdowns**, overflow collapse for long paths, path autocomplete in edit mode.

---

## Priority Roadmap (by perceived-impact for a Windows defector)

**Tier 1 — they'll notice within 60 seconds if missing:**
- Thumbnail **fade-in** + generic-icon placeholder (§9, §10) — currently hard-pops.
- **Touchpad pinch-zoom** in Photos (§18) — laptop users expect it instantly.
- **Cursor-anchored zoom** + drag-pan (§19).
- Recursive **search with streaming results** + progress (§13) — biggest functional-feel gap.
- Context-menu **icon strip** + acrylic + submenu safe-triangle (§6).

**Tier 2 — power-user muscle memory:**
- Breadcrumb **chevron sibling dropdowns** (§20).
- Missing shortcuts: `Ctrl+1..8` views, `Alt+Enter`, `F3`, `Ctrl+Tab`, middle-click-new-tab (§3, §4).
- Drag **ghost + count badge + operation cue**, spring-loaded folders, `Esc` cancel (§15).
- **Per-monitor** bounds persistence + off-screen clamp (§7, §16).

**Tier 3 — polish:**
- Toast system + Retry + inline elevate band (§12).
- Tab reorder / tear-off (§7).
- OS-keyring SMB credential persistence + UNC auto-mount (§14).
- `cursor:none` in fullscreen, reduced-motion guard, `transform-origin` on menus (§1, §17).

**What's already exemplary (don't regress):** thumbnail caching & memory discipline (§9–10), SMB mounting (§14), folder-load parallelism (§11), navigation history + scroll restore (§8), Photos fullscreen (§17), selection without re-render (§5).

---

## Cross-cutting technical notes

- **Animate only `transform`/`opacity`.** Everything else hits layout/paint and breaks the 60 fps illusion.
- **Delay every spinner ~600 ms and cancel-if-fast.** Single biggest perceived-perf lever.
- **Never `*Sync` on the main process.** One blocked `fs.statSync` freezes *all* windows.
- **Custom protocol over data-URIs** for any image served to the renderer (cache + GC friendly).
- **Decode bounded copies** (≤2048px) and free bitmaps (`createImageBitmap`/`close`) — Chromium does not evict decodes on `src` change (the OOM root cause already diagnosed in this app).
- **Test on the actual Mint target under both X11 and Wayland** — DnD (XDND), fullscreen, touchpad gestures, and fractional DPI all differ. XWayland is the safer default for drag-out.
- **Respect the Linux WM** for snapping/tiling/maximize — don't reimplement Snap Layouts in JS; keep a normal top-level window so Cinnamon/KWin/GNOME gestures work for free.
- **`prefers-reduced-motion`** — gate all chrome animation behind it for accessibility parity.

*Last updated: 2026-06-12. Findings cross-referenced against the current `fluent-explorer` v1.10.0 implementation.*
