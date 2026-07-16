// Bigger libuv threadpool → many fs.stat() calls run in parallel instead of 4-at-a-time.
// This is the single biggest win for browsing slow SMB/network folders (stat = network round-trip).
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64';

const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net, nativeImage, clipboard, Menu, crashReporter } = require('electron');

// Capture native crashes (renderer/GPU/utility) as local minidumps. NOTE: a Linux OOM-killer
// SIGKILL of the whole process is uncatchable and produces no dump — that's why "force-quit, no
// log". We detect that case separately by scanning the kernel log on next launch (see below).
try { crashReporter.start({ uploadToServer: false }); } catch {}

// GPU policy. On integrated GPUs (e.g. Mint) aggressively forcing GPU rasterization + zero-copy made
// the GPU process accumulate image textures and crash the whole app — even with plenty of free RAM.
// So those switches are now OPT-IN (FLUENT_GPU_RASTER=1) instead of the default. FLUENT_NO_GPU=1 still
// disables hardware acceleration entirely. Default = let Chromium decide (safest on weak drivers).
if (process.env.FLUENT_NO_GPU) {
  app.disableHardwareAcceleration();
} else if (process.env.FLUENT_GPU_RASTER) {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const { exec, spawn, execSync } = require('child_process');

// ── Linux desktop clipboard interop helpers (Nemo/Nautilus/Thunar) ──
const IS_WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
const _cmdCache = {};
function hasCmd(c) { if (c in _cmdCache) return _cmdCache[c]; try { execSync('which ' + c, { stdio: 'ignore' }); return _cmdCache[c] = true; } catch { return _cmdCache[c] = false; } }
const GNOME_TARGET = 'x-special/gnome-copied-files';

// Write file list to the SYSTEM clipboard in the GNOME format other file managers understand.
// Payload: "copy\nfile:///a\nfile:///b" with NO trailing newline. Uses xclip (X11) / wl-copy (Wayland).
function writeSystemClipboard(action, paths) {
  if (!paths || !paths.length) return false;
  const verb = action === 'cut' ? 'cut' : 'copy';
  const uris = paths.map(p => pathToFileURL(p).href); // correct file:/// + UTF-8 %-encoding
  const payload = [verb, ...uris].join('\n');         // no trailing newline (spurious empty URI otherwise)
  try {
    if (IS_WAYLAND && hasCmd('wl-copy')) {
      const p = spawn('wl-copy', ['-n', '--type', GNOME_TARGET], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.stdin.end(payload);
      // Also expose readable paths to text fields/terminals
      try { const t = spawn('wl-copy', ['-n', '--type', 'text/uri-list'], { stdio: ['pipe', 'ignore', 'ignore'] }); t.stdin.end(uris.join('\n')); } catch {}
      return true;
    }
    if (hasCmd('xclip')) {
      const p = spawn('xclip', ['-selection', 'clipboard', '-t', GNOME_TARGET, '-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.stdin.end(payload);
      return true;
    }
  } catch {}
  return false;
}

// Read a file list copied from another file manager. Returns {paths, action} or null.
function readSystemClipboard() {
  let out = '';
  try {
    if (IS_WAYLAND && hasCmd('wl-paste')) out = execSync(`wl-paste --type ${GNOME_TARGET} 2>/dev/null`, { encoding: 'utf8' });
    else if (hasCmd('xclip')) out = execSync(`xclip -selection clipboard -o -t ${GNOME_TARGET} 2>/dev/null`, { encoding: 'utf8' });
  } catch { return null; }
  if (!out) return null;
  const lines = out.replace(/\r/g, '').split('\n').filter(Boolean);
  let action = 'copy';
  const paths = [];
  for (const line of lines) {
    if (line === 'copy' || line === 'cut') { action = line; continue; }
    if (line.startsWith('file://')) { try { paths.push(fileURLToPath(line)); } catch {} }
  }
  return paths.length ? { paths, action } : null;
}

// stat() that can't hang forever on a dead network mount.
function statWithTimeout(full, ms) {
  return Promise.race([
    fs.promises.stat(full),
    new Promise((_, rej) => setTimeout(() => rej(new Error('stat timeout')), ms)),
  ]);
}

// Build a directory entry. Falls back to dirent type (no size/date) if stat times out,
// so a single unreachable file over SMB never drops the file or freezes the listing.
async function buildEntry(dirPath, d) {
  const full = path.join(dirPath, d.name);
  const ext = path.extname(d.name).toLowerCase().slice(1);
  const base = { name: d.name, path: full, ext, isImage: IMG_EXT.has(ext), isVideo: VID_EXT.has(ext) };
  try {
    const st = await statWithTimeout(full, 5000);
    return { ...base, isDirectory: st.isDirectory(), size: st.size, modified: st.mtime.toISOString().split('T')[0], modifiedMs: st.mtime.getTime(), createdMs: st.birthtime.getTime(), permissions: (st.mode & 0o777).toString(8) };
  } catch {
    return { ...base, isDirectory: d.isDirectory(), size: 0, modified: '', modifiedMs: 0, createdMs: 0, permissions: '', stale: true };
  }
}
let sharp;
let SHARP_JPEG_OK = false; // does this sharp/libvips build actually decode JPEG?
try {
  sharp = require('sharp');
  sharp.cache({ memory: 100, files: 20 });
  sharp.concurrency(2); // Limit sharp to 2 threads and 100MB cache
  // Some Linux sharp/libvips builds ship without a JPEG decoder → "Input file contains
  // unsupported image format" on ordinary .jpg. Probe it so we can skip straight to nativeImage.
  try { SHARP_JPEG_OK = !!(sharp.format && sharp.format.jpeg && sharp.format.jpeg.input && sharp.format.jpeg.input.file); } catch { SHARP_JPEG_OK = false; }
} catch { console.error('sharp not found, falling back to nativeImage'); }

const HOME = os.homedir();
const CACHE = path.join(HOME, '.cache', 'winex-thumbs');
const CFG = path.join(HOME, '.config');
try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}

// Thumb/display cache grows forever (a thumb + a display copy per image, plus fresh entries for every
// copied file) → "duplicates in the cache" + slow loading. Prune oldest to a size cap on startup.
// ponytail: sync stat sweep at startup; fine for a disposable regenerable cache, revisit if it lags.
function pruneCache(maxMB = 600) {
  try {
    const files = fs.readdirSync(CACHE).filter(f => f.endsWith('.jpg')).map(f => {
      const p = path.join(CACHE, f); const s = fs.statSync(p); return { p, size: s.size, mtime: s.mtimeMs };
    });
    let total = files.reduce((a, f) => a + f.size, 0);
    const cap = maxMB * 1048576;
    if (total <= cap) return;
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const f of files) { if (total <= cap) break; try { fs.unlinkSync(f.p); total -= f.size; } catch {} }
  } catch {}
}

const IMG_EXT = new Set(['jpg','jpeg','png','gif','bmp','webp','svg','ico','tiff','avif','heic']);
const VID_EXT = new Set(['mp4','avi','mkv','mov','webm','flv','wmv','m4v','mpg','mpeg','3gp']);

let explorerWin = null;
let photosWins = new Set();
const isPhotosOnly = process.argv.includes('--photos');

// ══════════════ GLOBAL STATE ══════════════
let globalClipboard = { paths: [], action: '' };
// Stored sorted image list for Photos to pick up, keyed by the target BrowserWindow's id.
// Keying per-window (instead of one shared slot) is what lets multiple Photos windows open
// back-to-back without racing each other for the same pending data.
const pendingPhotosDataByWin = new Map(); // winId -> { sortedPaths:[], startImage:'' }

ipcMain.handle('clip:set', (_, d) => {
  globalClipboard = d;
  // Mirror to the system clipboard so Nautilus/Nemo/Thunar can paste our files.
  // Primary: xclip/wl-copy (reliable cross-app). Fallback: Electron writeBuffer.
  if (d.paths && d.paths.length) {
    const ok = writeSystemClipboard(d.action, d.paths);
    if (!ok) {
      try {
        const action = d.action === 'cut' ? 'cut' : 'copy';
        const uris = d.paths.map(p => pathToFileURL(p).href).join('\n');
        clipboard.writeBuffer(GNOME_TARGET, Buffer.from(action + '\n' + uris, 'utf8'));
        clipboard.writeText(uris);
      } catch {}
    }
  }
});
ipcMain.handle('clip:get', () => {
  // The system clipboard is the source of truth so we also see files copied in Nemo/Nautilus
  // AFTER we last copied in-app. Fall back to the internal clipboard if the tools aren't present.
  const sys = readSystemClipboard();
  if (sys && sys.paths.length) return sys;

  // Electron buffer fallback (works within our own app even without xclip/wl-clipboard)
  try {
    const buf = clipboard.readBuffer(GNOME_TARGET);
    if (buf && buf.length > 2) {
      const lines = buf.toString('utf8').replace(/\r/g, '').split('\n').filter(Boolean);
      let action = 'copy';
      const paths = [];
      for (const line of lines) {
        if (line === 'copy' || line === 'cut') { action = line; continue; }
        if (line.startsWith('file://')) { try { paths.push(fileURLToPath(line)); } catch {} }
      }
      if (paths.length) return { paths, action };
    }
  } catch {}
  try {
    const text = clipboard.readText();
    if (text && text.includes('file:///')) {
      const paths = text.split('\n').filter(l => l.startsWith('file://')).map(l => { try { return fileURLToPath(l.trim()); } catch { return null; } }).filter(Boolean);
      if (paths.length) return { paths, action: 'copy' };
    }
  } catch {}
  return globalClipboard;
});

// Photos requests the sorted list — keyed per-window, so it's a one-shot per Photos window
// instead of a single shared slot that a second window could steal or clobber.
// When nothing was pre-staged for this window (e.g. it was opened via the single-instance
// second-instance handler, which only has a folder + image path, no sorted list), fall back
// to scanning that window's own folder so it still gets a navigable, sorted image list.
ipcMain.handle('photos:getSortedList', async (event, folder) => {
  const winId = BrowserWindow.fromWebContents(event.sender)?.id;
  const data = winId != null ? pendingPhotosDataByWin.get(winId) : null;
  if (winId != null) pendingPhotosDataByWin.delete(winId); // consume it
  if (data) return data;
  if (!folder) return null;
  try {
    const dirents = await fs.promises.readdir(folder, { withFileTypes: true });
    const sortedPaths = dirents
      .filter(d => !d.isDirectory() && !d.name.startsWith('.') && IMG_EXT.has(path.extname(d.name).toLowerCase().slice(1)))
      .map(d => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map(name => path.join(folder, name));
    return sortedPaths.length ? { sortedPaths, startImage: '' } : null;
  } catch { return null; }
});

// Turn the built-in Ctrl/Cmd+R "reload whole renderer" into an in-app folder refresh.
// A full reload re-runs init() and restores a stale/last-saved session (→ "jumps to Home").
// preventDefault() here also suppresses the default menu's reload accelerator.
function guardReload(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && (input.key === 'r' || input.key === 'R')) {
      event.preventDefault();
      win.webContents.send('fx:refresh');
    }
  });
}

// Keep the renderer's chrome in sync with real OS fullscreen state, however it was triggered
// (our button, F11 in-app, or the window manager).
function wireFullScreen(win) {
  const send = on => { try { win.webContents.send('fx:fullscreen', on); } catch {} };
  win.on('enter-full-screen', () => send(true));
  win.on('leave-full-screen', () => send(false));
}

function createExplorerWindow() {
  explorerWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 500, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, 'icon.svg'), backgroundColor: '#f3f3f3'
  });
  explorerWin.loadFile('explorer.html');
  guardReload(explorerWin);
  wireFullScreen(explorerWin);
  explorerWin.on('closed', () => { explorerWin = null; });
}

function createPhotosWindow(folder, imagePath, sortedImagePaths) {
  const win = new BrowserWindow({
    width: 1100, height: 750, minWidth: 700, minHeight: 500, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, 'icon.svg'), backgroundColor: '#111111'
  });
  // Store the sorted list BEFORE loading — Photos will request it on init, keyed to THIS
  // window's id so a second Photos window opening around the same time can't steal/clobber it.
  if (sortedImagePaths && sortedImagePaths.length) {
    pendingPhotosDataByWin.set(win.id, { sortedPaths: sortedImagePaths, startImage: imagePath });
  }
  win.loadFile('photos.html', { query: { folder: folder || '', image: imagePath || '' } });
  guardReload(win);
  wireFullScreen(win);
  photosWins.add(win);
  win.on('closed', () => { photosWins.delete(win); pendingPhotosDataByWin.delete(win.id); });
  // Make sure a newly opened Photos window actually surfaces — without this a second window
  // can load behind the first (or behind the Explorer window) instead of becoming usable.
  win.once('ready-to-show', () => {
    try { win.show(); win.focus(); if (win.moveTop) win.moveTop(); } catch {}
  });
}

// Single instance: a 2nd launch (e.g. the dashboard opening an image via `--photos folder
// image`) is routed INTO the already-running app instead of spawning another Electron —
// instant, and no process pileup. If no instance is running, this one becomes it.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
app.on('second-instance', (event, argv) => {
  const i = argv.indexOf('--photos');
  if (i >= 0) {
    createPhotosWindow(argv[i + 1] || path.join(HOME, 'Pictures'), argv[i + 2] || '');
  } else if (explorerWin) {
    try { if (explorerWin.isMinimized()) explorerWin.restore(); explorerWin.focus(); } catch {}
  } else {
    createExplorerWindow();
  }
});
app.whenReady().then(() => {
  // Remove the default application menu — it's what provides the Ctrl/Cmd+R "reload" accelerator
  // that was blowing away the renderer and dumping the user back on Home. The app drives all of
  // its own shortcuts from the renderer; the only menu-provided one we want (refresh) is handled
  // via guardReload → 'fx:refresh'.
  Menu.setApplicationMenu(null);
  // Register protocol to serve local files — more reliable than file:// which gets blocked by CSP
  protocol.registerFileProtocol('localthumb', (request, callback) => {
    // URL format: localthumb://FILEPATH
    let fp = request.url.slice('localthumb://'.length);
    fp = decodeURIComponent(fp);
    // Handle Windows-style double-slash or leading slash
    if (fp.startsWith('/')) callback({ path: fp });
    else callback({ path: '/' + fp });
  });
  if (isPhotosOnly) createPhotosWindow(process.argv[3] || path.join(HOME, 'Pictures'), process.argv[4] || '');
  else createExplorerWindow();
  detectPriorUncleanExit(); // did the LAST session die without a clean shutdown? (OOM-kill etc.)
  checkPriorOOM();          // also try the kernel log for the *reason* (best-effort; needs journal perms)
  startMemorySampler();     // log the per-process memory curve + heartbeat the liveness marker
  pruneCache();             // keep the thumb/display cache bounded
});
}  // end single-instance guard
// Clean-exit path: clear the liveness marker so the NEXT launch knows we shut down properly.
app.on('window-all-closed', () => { markCleanExit(); app.quit(); });
app.on('before-quit', () => markCleanExit());

// Crash diagnostics → ~/.cache/winex-crash.log. A renderer/GPU OOM kills the process before any
// in-app log flushes, so these OS-level events are the only record of *why* it died.
const CRASHLOG = path.join(HOME, '.cache', 'winex-crash.log');
function logCrash(obj){ try { fs.appendFileSync(CRASHLOG, JSON.stringify({ ...obj, date: new Date().toISOString() }) + '\n'); } catch {} }
app.on('render-process-gone', (_e, wc, d) => logCrash({ event: 'render-process-gone', reason: d.reason, exitCode: d.exitCode, mem: getResUsage(), viewer: lastViewerState }));
app.on('child-process-gone', (_e, d) => logCrash({ event: 'child-process-gone', type: d.type, name: d.name, reason: d.reason, exitCode: d.exitCode, mem: getResUsage(), viewer: lastViewerState }));
// A GPU-process death (common on weak/integrated drivers) shows up as child-process-gone type 'GPU'.
// Catch main-process JS faults too — not a native segfault, but records the reason before we die.
process.on('uncaughtException', err => { try { logCrash({ event: 'main_uncaught', error: err && (err.stack || err.message || String(err)), mem: getResUsage(), viewer: lastViewerState }); } catch {} });
process.on('unhandledRejection', reason => { try { logCrash({ event: 'main_unhandled_rejection', reason: String((reason && (reason.stack || reason.message)) || reason) }); } catch {} });

// ── Session liveness marker ── The whole point: a Linux OOM-kill SIGKILLs us with NO catchable event
// and NO journal permission on most desktops, so winex-crash.log stayed empty. We instead write a
// marker every heartbeat while running and clear it on a clean quit. If it's still present (and not
// ours) at the NEXT launch, the previous session died uncleanly → we log it, with the last memory
// sample + the image the viewer was on. This produces a crash record WITHOUT needing kernel logs.
const SESSION_LIVE = path.join(HOME, '.cache', 'winex-session-live.json');
const APP_VERSION = (() => { try { return require('./package.json').version; } catch { return '?'; } })();
let lastViewerState = null;     // {i,total,name} most recent image shown in any Photos window
let cleanExit = false;
function writeLiveMarker() {
  try {
    const rows = app.getAppMetrics().map(m => ({ type: m.type, ws: Math.round(m.memory.workingSetSize / 1024) }));
    const peakRss = Math.max(0, ...rows.map(r => r.ws));
    fs.writeFileSync(SESSION_LIVE, JSON.stringify({
      pid: process.pid, version: APP_VERSION, running: true,
      ts: Date.now(), freeMB: Math.round(os.freemem() / 1048576),
      peakProcMB: peakRss, procs: rows, viewer: lastViewerState,
    }));
  } catch {}
}
function markCleanExit() { if (cleanExit) return; cleanExit = true; try { fs.unlinkSync(SESSION_LIVE); } catch {} }
function detectPriorUncleanExit() {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(SESSION_LIVE, 'utf8')); } catch { prev = null; }
  // Stale marker present from a DIFFERENT pid that never cleaned up → previous session died hard.
  if (prev && prev.running && prev.pid !== process.pid) {
    logCrash({
      event: 'unclean_shutdown', note: 'previous session ended without a clean quit (likely OOM-kill / force-quit)',
      prevVersion: prev.version, lastSeenTs: prev.ts, lastFreeMB: prev.freeMB,
      peakProcMB: prev.peakProcMB, lastProcs: prev.procs, diedAt: prev.viewer,
    });
  }
  writeLiveMarker();
}

// A kernel OOM-kill can't be caught in-process (SIGKILL). Detect the PREVIOUS session's OOM-kill by
// scanning the kernel log on launch (best-effort — many desktops deny journal access to non-root).
function checkPriorOOM() {
  exec('journalctl -k -b -1 --no-pager 2>/dev/null | grep -iE "killed process.*(electron|fluent|win-explorer)" | tail -3', { timeout: 4000 }, (e, out) => {
    if (!e && out && out.trim()) logCrash({ event: 'prior_oom_kill', detail: out.trim().split('\n') });
  });
  // dmesg fallback (also commonly restricted, but free to try).
  exec('dmesg 2>/dev/null | grep -iE "killed process.*(electron|fluent|win-explorer)" | tail -3', { timeout: 4000 }, (e, out) => {
    if (!e && out && out.trim()) logCrash({ event: 'prior_oom_kill_dmesg', detail: out.trim().split('\n') });
  });
}
// Sample per-process memory (incl. GPU) every 5s into the debug log so a reproduction produces the
// climbing curve — direct evidence of accumulation. Also heartbeats the liveness marker, and warns
// to the crash log when free memory gets dangerously low (early evidence before a possible OOM-kill).
let _lowMemWarned = false;
function startMemorySampler() {
  setInterval(() => {
    try {
      const rows = app.getAppMetrics().map(m => ({ type: m.type, ws: Math.round(m.memory.workingSetSize / 1024) /*MB*/ }));
      const freeMB = Math.round(os.freemem() / 1048576);
      dbg({ event: 'mem', procs: rows, freeMB, viewer: lastViewerState });
      writeLiveMarker();
      if (freeMB < 350 && !_lowMemWarned) { _lowMemWarned = true; logCrash({ event: 'low_memory_warning', freeMB, procs: rows, viewer: lastViewerState }); }
      else if (freeMB > 700) { _lowMemWarned = false; }
    } catch {}
  }, 5000);
}

// Renderer diagnostics → debug log (decode failures etc.) and the viewer's current image → memory.
ipcMain.on('diag:client', (_e, o) => { try { dbg({ event: 'client', ...o }); } catch {} });
ipcMain.on('diag:viewer', (_e, s) => { lastViewerState = s; });

ipcMain.handle('app:openPhotos', (_, folder, imagePath, sortedImagePaths) => {
  createPhotosWindow(folder, imagePath, sortedImagePaths);
  return { ok: 1 };
});

// ══════════════ FILESYSTEM ══════════════
ipcMain.handle('fs:readdir', async (_, dirPath) => {
  try {
    const dirents = (await fs.promises.readdir(dirPath, { withFileTypes: true })).filter(d => !d.name.startsWith('.'));
    const results = await Promise.all(dirents.map(d => buildEntry(dirPath, d)));
    return { ok: 1, entries: results };
  } catch (e) { return { ok: 0, error: e.message }; }
});

ipcMain.handle('fs:listImages', async (_, dirPath) => {
  try {
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const images = [];
    for (const d of dirents) {
      if (d.name.startsWith('.') || d.isDirectory()) continue;
      const ext = path.extname(d.name).toLowerCase().slice(1);
      if (!IMG_EXT.has(ext)) continue;
      const full = path.join(dirPath, d.name);
      try { const st = await fs.promises.stat(full); images.push({ name: d.name, path: full, ext, size: st.size, modified: st.mtime.toISOString(), modifiedDate: st.mtime.toISOString().split('T')[0] }); } catch {}
    }
    images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return images;
  } catch { return []; }
});

ipcMain.handle('fs:scanImages', async (_, dirPath, maxDepth) => {
  const images = [];
  async function walk(dir, depth) {
    if (depth > (maxDepth || 4)) return;
    try { for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue; const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else { const ext = path.extname(e.name).toLowerCase().slice(1); if (IMG_EXT.has(ext)) { try { const st = await fs.promises.stat(full); images.push({ name: e.name, path: full, ext, size: st.size, modified: st.mtime.toISOString(), modifiedDate: st.mtime.toISOString().split('T')[0] }); } catch {} } }
    }} catch {}
  }
  await walk(dirPath, 0); return images;
});

// ══════════════ RECURSIVE STREAMING SEARCH ══════════════
// Windows Explorer searches the current folder + all subfolders and streams matches into the view as
// it finds them (with a progress bar), rather than blocking until the whole tree is walked. We mirror
// that: a breadth-first walk (shallow = more-relevant results first), matches pushed back over IPC in
// small throttled batches, cancellable at any time, and bounded so a huge tree can't run away.
const activeSearches = new Set();
ipcMain.on('search:cancel', (_e, { id }) => activeSearches.delete(id));
ipcMain.on('search:start', async (e, { id, root, query, opts }) => {
  const wc = e.sender;
  const send = (ch, payload) => { try { if (!wc.isDestroyed()) wc.send(ch, { id, ...payload }); } catch {} };
  const q = (query || '').trim();
  if (!q || !root) { send('search:done', { count: 0, scanned: 0, capped: false }); return; }
  activeSearches.add(id);

  // `*`/`?` → glob on the whole name; otherwise case-insensitive substring (the common case).
  const useGlob = /[*?]/.test(q);
  const rx = useGlob ? new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
  const ql = q.toLowerCase();
  const match = name => useGlob ? rx.test(name) : name.toLowerCase().includes(ql);

  const MAX_RESULTS = (opts && opts.maxResults) || 5000;
  const MAX_DEPTH   = (opts && opts.maxDepth)   || 16;
  let count = 0, scanned = 0, capped = false, lastFlush = 0;
  let batch = [];
  const flush = force => {
    if (!batch.length) return;
    if (force || batch.length >= 40 || (lastFlush && Date.now() - lastFlush > 120)) {
      send('search:result', { items: batch }); batch = []; lastFlush = Date.now();
    }
  };

  const queue = [{ dir: root, depth: 0 }];
  try {
    while (queue.length) {
      if (!activeSearches.has(id)) return; // cancelled
      const { dir, depth } = queue.shift();
      let dirents;
      try {
        // Per-directory timeout so one dead SMB handle can't stall the whole search.
        dirents = await Promise.race([
          fs.promises.readdir(dir, { withFileTypes: true }),
          new Promise((_, r) => setTimeout(() => r(new Error('readdir timeout')), 8000)),
        ]);
      } catch { continue; }
      for (const d of dirents) {
        if (!activeSearches.has(id)) return;
        if (d.name.startsWith('.')) continue;
        scanned++;
        const full = path.join(dir, d.name);
        const isDir = d.isDirectory();
        if (match(d.name)) {
          const ext = path.extname(d.name).toLowerCase().slice(1);
          batch.push({ name: d.name, path: full, dir, isDirectory: isDir, isImage: IMG_EXT.has(ext), isVideo: VID_EXT.has(ext), ext });
          if (++count >= MAX_RESULTS) { capped = true; break; }
        }
        if (isDir && depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
      }
      flush(false);
      send('search:progress', { scanned, count, current: dir });
      if (capped) break;
      await new Promise(r => setImmediate(r)); // yield so cancel messages are processed promptly
    }
  } finally {
    flush(true);
    activeSearches.delete(id);
    send('search:done', { count, scanned, capped });
  }
});

// ══════════════ THUMBNAILS v2 — SHARP-BASED, NON-BLOCKING ══════════════
// sharp uses libvips: processes in worker threads, constant memory (~50MB),
// never loads full image into RAM. 10-50x faster than nativeImage.
const thumbMemCache = new Map();
const DEBUG_LOG = path.join(HOME, '.cache', 'winex-debug.log');
const PERF_LOG = path.join(HOME, '.cache', 'winex-performance.log');
let debugLogStream = null, perfLogStream = null;

function dbg(obj) {
  if (!debugLogStream) { try { debugLogStream = fs.createWriteStream(DEBUG_LOG, { flags: 'a' }); } catch { return; } let ver='?'; try { ver = require('./package.json').version; } catch {} debugLogStream.write(JSON.stringify({ event: 'app_start', version: ver, gpu: !process.env.FLUENT_NO_GPU, ts: Date.now() }) + '\n'); }
  debugLogStream.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
}
function perfLog(obj) {
  if (!perfLogStream) { try { perfLogStream = fs.createWriteStream(PERF_LOG, { flags: 'a' }); } catch { return; } }
  perfLogStream.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
}

function normPath(p) { return path.resolve(p); }
function hashPath(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

// Cache version
const CVF = path.join(CACHE, '.cache_version');
try { if (fs.readFileSync(CVF, 'utf8').trim() !== '4') throw 0; }
catch { try { for (const f of fs.readdirSync(CACHE)) { if (f.endsWith('.jpg')) fs.unlinkSync(path.join(CACHE, f)); } } catch {} fs.writeFileSync(CVF, '4'); }

// Resource monitor
function getResUsage() {
  const m = process.memoryUsage();
  return { rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576), loadPct: Math.round(os.loadavg()[0] / os.cpus().length * 100), freeMB: Math.round(os.freemem() / 1048576), totalMB: Math.round(os.totalmem() / 1048576), cached: thumbMemCache.size };
}

// ═══ BATCH THUMBNAIL GENERATOR ═══
// Instead of 13,000 individual IPC calls, the renderer sends a batch of
// visible paths (max 30). This runs them sequentially with sharp.
let batchAbortId = 0;

// Generate a 200px JPEG thumbnail at `cp`. sharp first (fast) when its JPEG decoder works,
// otherwise Electron's nativeImage (Chromium codecs) — the fix for libvips builds that throw
// "Input file contains unsupported image format" on ordinary JPEGs. Returns true on success.
async function generateThumbFile(fp, cp) {
  if (sharp && SHARP_JPEG_OK) {
    try {
      await sharp(fp, { failOn: 'none', limitInputPixels: 300000000 })
        .rotate() // honor EXIF orientation
        .resize(200, 200, { fit: 'cover', withoutEnlargement: true })
        .jpeg({ quality: 72, mozjpeg: true })
        .toFile(cp);
      return true;
    } catch (e) {
      // This libvips build's JPEG decoder is broken (the probe lied). sharp failing repeatedly in
      // the main process is a native-crash liability during a fast scrub, so once it fails we STOP
      // using sharp entirely and rely on Electron's nativeImage (Chromium codecs) from here on.
      if (SHARP_JPEG_OK) { SHARP_JPEG_OK = false; dbg({ event: 'sharp_disabled', reason: e.message }); }
      else dbg({ event: 'sharp_fail_fallback', path: fp, error: e.message });
    }
  }
  try {
    const img = nativeImage.createFromPath(fp);
    if (!img.isEmpty()) {
      await fs.promises.writeFile(cp, img.resize({ width: 200, quality: 'good' }).toJPEG(72));
      return true;
    }
  } catch (e) { dbg({ event: 'nativeimage_fail', path: fp, error: e.message }); }
  return false;
}

ipcMain.handle('fs:generateThumbBatch', async (_, paths, batchId) => {
  // NOTE: no global batchAbortId abort here. The renderer self-throttles (IntersectionObserver
  // only requests near-viewport items) and serializes flushes, so the old abort check just made
  // overlapping batches cancel each other — which broke thumbnails in large image/video folders.
  const results = {};
  for (const rawPath of paths) {
    const fp = normPath(rawPath);
    // Already cached?
    if (thumbMemCache.has(fp)) { results[rawPath] = thumbMemCache.get(fp); continue; }
    const hash = hashPath(fp);
    const cp = path.join(CACHE, hash + '.jpg');
    // On disk?
    try { await fs.promises.access(cp); const url = 'localthumb://' + cp; thumbMemCache.set(fp, url); results[rawPath] = url; continue; } catch {}
    // Check resources
    const res = getResUsage();
    if (res.freeMB < 300 || res.rssMB > 1000) {
      perfLog({ event: 'batch_paused_resources', ...res });
      await new Promise(r => setTimeout(r, 1000)); // Wait 1 second for resources to free
      const res2 = getResUsage();
      if (res2.freeMB < 200) { results[rawPath] = null; continue; } // Still low, skip this one
    }
    // Generate thumbnail
    try {
      const ext = path.extname(fp).toLowerCase().slice(1);
      const isVideo = VID_EXT.has(ext);

      if (isVideo) {
        // Video files: use ffmpeg to extract a frame
        let ffmpegOk = false;
        try { execSync('which ffmpeg', { stdio: 'ignore' }); ffmpegOk = true; } catch {}
        if (ffmpegOk) {
          await new Promise((resolve) => {
            const proc = spawn('ffmpeg', ['-i', fp, '-ss', '2', '-vframes', '1', '-vf', 'scale=200:-1', '-q:v', '8', '-y', cp], { stdio: 'ignore', timeout: 8000 });
            proc.on('close', code => resolve(code));
            proc.on('error', () => resolve(1));
            setTimeout(() => { try { proc.kill(); } catch {} resolve(1); }, 8000);
          });
          try { await fs.promises.access(cp); } catch { thumbMemCache.set(fp, null); results[rawPath] = null; continue; }
        } else {
          thumbMemCache.set(fp, null); results[rawPath] = null; continue;
        }
      } else {
        // Image files: sharp if healthy, else Electron nativeImage (robust JPEG/PNG decode)
        const ok = await generateThumbFile(fp, cp);
        if (!ok) { thumbMemCache.set(fp, null); results[rawPath] = null; dbg({ event: 'thumb_error', path: fp, error: 'decode failed (sharp+nativeImage)' }); continue; }
      }
      const url = 'localthumb://' + cp;
      thumbMemCache.set(fp, url);
      results[rawPath] = url;
    } catch (e) {
      thumbMemCache.set(fp, null);
      results[rawPath] = null;
      dbg({ event: 'thumb_error', path: fp, error: e.message });
    }
  }
  return results;
});

// Cancel current batch (called when user navigates to different folder)
ipcMain.handle('fs:cancelThumbBatch', () => {
  batchAbortId++;
  return batchAbortId;
});

// Get new batch ID (renderer calls this before each batch request)
ipcMain.handle('fs:newBatchId', () => {
  batchAbortId++;
  return batchAbortId;
});

// Single thumb (for filmstrip etc)
ipcMain.handle('fs:getThumb', async (_, filePath) => {
  const fp = normPath(filePath);
  if (thumbMemCache.has(fp)) return thumbMemCache.get(fp);
  const hash = hashPath(fp);
  const cp = path.join(CACHE, hash + '.jpg');
  try { await fs.promises.access(cp); const url = 'localthumb://' + cp; thumbMemCache.set(fp, url); return url; } catch {}
  const ok = await generateThumbFile(fp, cp);
  if (!ok) { thumbMemCache.set(fp, null); return null; }
  const url = 'localthumb://' + cp;
  thumbMemCache.set(fp, url);
  return url;
});

ipcMain.handle('fs:getVideoThumb', async (_, vp) => {
  const fp = normPath(vp);
  if (thumbMemCache.has(fp)) return thumbMemCache.get(fp);
  const hash = hashPath(fp);
  const cp = path.join(CACHE, 'v_' + hash + '.jpg');
  try { await fs.promises.access(cp); const url = 'localthumb://' + cp; thumbMemCache.set(fp, url); return url; } catch {}
  try { execSync('which ffmpeg', { stdio: 'ignore' }); } catch { return null; }
  return new Promise(resolve => {
    const p = spawn('ffmpeg', ['-i', fp, '-ss', '2', '-vframes', '1', '-vf', 'scale=200:-1', '-q:v', '8', '-y', cp], { stdio: 'ignore', timeout: 6000 });
    p.on('close', code => { const url = code === 0 ? 'localthumb://' + cp : null; thumbMemCache.set(fp, url); resolve(url); });
    p.on('error', () => resolve(null));
    setTimeout(() => { try { p.kill(); } catch {} }, 6000);
  });
});

ipcMain.handle('fs:imageUrl', (_, p) => 'localthumb://' + normPath(p));

// Display-sized image for the viewer. Decoding the FULL-resolution original for every photo is what
// exhausted memory when scrubbing (a 12MP photo = ~48MB decoded; a few hundred of those = OOM crash).
// We make a screen-sized (<=2048px) cached JPEG and show that instead — ~8MB decoded, bounded RAM.
// Small images pass through untouched. Falls back to the original on any failure.
const DISPLAY_MAX = 2048;
// Resolve the on-disk file to *show* for `filePath`: the cached <=2048px JPEG (generated on demand),
// or the original when it's already small / a GIF / can't be re-encoded. Returns an absolute path.
async function resolveDisplayPath(filePath) {
  const fp = normPath(filePath);
  const ext = path.extname(fp).toLowerCase().slice(1);
  if (ext === 'gif') return fp; // keep animation
  const cp = path.join(CACHE, 'd_' + hashPath(fp + '@' + DISPLAY_MAX) + '.jpg');
  try { await fs.promises.access(cp); return cp; } catch {}
  if (sharp && SHARP_JPEG_OK) {
    try {
      const meta = await sharp(fp).metadata();
      if (meta && Math.max(meta.width || 0, meta.height || 0) <= DISPLAY_MAX) return fp; // already small
      await sharp(fp, { failOn: 'none', limitInputPixels: 1000000000 })
        .rotate()
        .resize(DISPLAY_MAX, DISPLAY_MAX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86 })
        .toFile(cp);
      return cp;
    } catch (e) { dbg({ event: 'display_sharp_fail', path: fp, error: e.message }); }
  }
  try {
    const img = nativeImage.createFromPath(fp);
    if (!img.isEmpty()) {
      const sz = img.getSize();
      if (Math.max(sz.width, sz.height) <= DISPLAY_MAX) return fp;
      const scaled = sz.width >= sz.height ? img.resize({ width: DISPLAY_MAX, quality: 'better' }) : img.resize({ height: DISPLAY_MAX, quality: 'better' });
      await fs.promises.writeFile(cp, scaled.toJPEG(86));
      return cp;
    }
  } catch (e) { dbg({ event: 'display_native_fail', path: fp, error: e.message }); }
  return fp;
}

ipcMain.handle('fs:getDisplayImage', async (_, filePath) => 'localthumb://' + await resolveDisplayPath(filePath));

// Return image BYTES for the viewer to decode in the RENDERER (Chromium codecs) via
// createImageBitmap()+close(). Two wins over the old approach:
//   1) No decoded pixels pile up in Chromium's <img> cache → flat renderer memory.
//   2) NO image decode in the MAIN process — sharp/nativeImage are never touched here, so a native
//      decoder fault can't take down the whole app (that crashed BOTH windows at ~200 images).
// We send an existing display-sized copy if one is already on disk (smaller IPC), else the original.
// We never GENERATE one here (that would mean a main-process decode again).
ipcMain.handle('fs:getDisplayBytes', async (_, filePath) => {
  try {
    const fp = normPath(filePath);
    const ext = path.extname(fp).toLowerCase().slice(1);
    if (ext !== 'gif') {
      const cp = path.join(CACHE, 'd_' + hashPath(fp + '@' + DISPLAY_MAX) + '.jpg');
      try { await fs.promises.access(cp); const buf = await fs.promises.readFile(cp); return { ok: 1, buf, sized: true }; } catch {}
    }
    const buf = await fs.promises.readFile(fp);
    return { ok: 1, buf, sized: false };
  } catch (e) { dbg({ event: 'display_bytes_fail', path: filePath, error: e.message }); return { ok: 0, error: e.message }; }
});
ipcMain.handle('fs:getCachedThumbs', (_, paths) => { const r = {}; for (const p of paths) { const np = normPath(p); if (thumbMemCache.has(np)) r[p] = thumbMemCache.get(np); } return r; });
ipcMain.handle('fs:getResourceUsage', () => getResUsage());
ipcMain.handle('fs:clearThumbQueue', () => { batchAbortId++; return { cleared: 0 }; });

// ══════════════ STANDARD FS OPS ══════════════
ipcMain.handle('fs:homedir', () => HOME);
ipcMain.handle('fs:quickPaths', () => ({ home: HOME, desktop: path.join(HOME,'Desktop'), documents: path.join(HOME,'Documents'), downloads: path.join(HOME,'Downloads'), music: path.join(HOME,'Music'), pictures: path.join(HOME,'Pictures'), videos: path.join(HOME,'Videos'), trash: path.join(HOME,'.local/share/Trash/files') }));
ipcMain.handle('fs:openFile', async (_,p) => { try{await shell.openPath(p);return{ok:1}}catch(e){return{ok:0,error:e.message}} });
ipcMain.handle('fs:trash', async (_,p) => { try{await shell.trashItem(p);return{ok:1}}catch(e){return{ok:0,error:e.message}} });
ipcMain.handle('fs:rename', async (_,o,n) => {
  try {
    await fs.promises.rename(o, path.join(path.dirname(o), n));
    return { ok: 1 };
  } catch (e) {
    if (e.code === 'EXDEV') {
      // Cross-device rename — copy then delete
      try {
        const dest = path.join(path.dirname(o), n);
        await universalCopyFile(o, dest);
        await fs.promises.unlink(o);
        return { ok: 1 };
      } catch (e2) { return { ok: 0, error: e2.message }; }
    }
    return { ok: 0, error: e.message };
  }
});

// ═══ UNIVERSAL FILE COPY — works on local, GVFS, NFS, CIFS, FUSE ═══
// fs.copyFile uses copy_file_range syscall which fails on GVFS socket mounts.
// This falls back to stream copy (read→write pipe) which works everywhere.
async function universalCopyFile(src, dest) {
  try {
    // Try native copyFile first (fastest for local→local)
    await fs.promises.copyFile(src, dest);
  } catch (e) {
    if (e.code === 'ENOTSUP' || e.code === 'ENOSYS' || e.code === 'EXDEV') {
      // Fallback: stream copy (works on GVFS, FUSE, NFS, CIFS, any filesystem)
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(src);
        const ws = fs.createWriteStream(dest);
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        rs.pipe(ws);
      });
      // Preserve modification time
      try {
        const st = await fs.promises.stat(src);
        await fs.promises.utimes(dest, st.atime, st.mtime);
      } catch {}
    } else {
      throw e; // Re-throw other errors (permission denied, etc.)
    }
  }
}

async function cpR(s, d) {
  await fs.promises.mkdir(d, { recursive: true });
  for (const e of await fs.promises.readdir(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name), dp = path.join(d, e.name);
    if (e.isDirectory()) await cpR(sp, dp);
    else await universalCopyFile(sp, dp);
  }
}

ipcMain.handle('fs:copy', async (_, s, d) => {
  try {
    const dest = path.join(d, path.basename(s));
    const st = await fs.promises.stat(s);
    if (st.isDirectory()) await cpR(s, dest);
    else await universalCopyFile(s, dest);
    return { ok: 1 };
  } catch (e) { return { ok: 0, error: e.message }; }
});
ipcMain.handle('fs:copyFile', async (_, s, d) => {
  try { await universalCopyFile(s, path.join(d, path.basename(s))); return { ok: 1 }; }
  catch (e) { return { ok: 0, error: e.message }; }
});
ipcMain.handle('fs:mkdir', async (_,p) => { try{await fs.promises.mkdir(p,{recursive:true});return{ok:1}}catch(e){return{ok:0,error:e.message}} });
ipcMain.handle('fs:stat', async (_,p) => { try{const s=await fs.promises.stat(p);return{ok:1,stats:{size:s.size,created:s.birthtime.toISOString(),modified:s.mtime.toISOString(),permissions:(s.mode&0o777).toString(8),isDirectory:s.isDirectory()}}}catch(e){return{ok:0,error:e.message}} });
ipcMain.handle('fs:permanentDelete', async (event, filePaths) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const r = await dialog.showMessageBox(win, { type:'warning', buttons:['Cancel','Delete Permanently'], defaultId:0, title:'Permanent Delete', message:`Permanently delete ${filePaths.length} item(s)?\n\nThis cannot be undone.` });
  if (r.response !== 1) return { ok: 0 };
  for (const p of filePaths) { try { await fs.promises.rm(p, { recursive: true, force: true }); } catch {} }
  return { ok: 1 };
});

// Terminal
ipcMain.handle('fs:openTerminal', (_,dir) => {
  for(const t of ['gnome-terminal','mate-terminal','xfce4-terminal','konsole']){try{execSync(`which ${t}`,{stdio:'ignore'});if(t==='konsole')spawn(t,['--workdir',dir],{detached:true,stdio:'ignore'}).unref();else spawn(t,['--working-directory='+dir],{detached:true,stdio:'ignore'}).unref();return{ok:1}}catch{}}
  spawn('x-terminal-emulator',[],{cwd:dir,detached:true,stdio:'ignore'}).unref();return{ok:1};
});

// Config
function cfgFile(n){return path.join(CFG,'winex-'+n+'.json')}

// Legacy config file names from older versions
const LEGACY_CONFIG_NAMES = {
  'bookmarks': ['win-explorer-bookmarks.json', 'winex-bookmarks.json'],
  'settings': ['win-explorer-settings.json', 'winex-settings.json'],
  'sortprefs': ['win-explorer-sortprefs.json', 'winex-sortprefs.json'],
  'networks': ['win-explorer-networks.json', 'winex-networks.json'],
  'session': ['win-explorer-session.json', 'winex-session.json'],
};

ipcMain.handle('cfg:load', async (_,n,def) => {
  // Try current filename first
  try { return JSON.parse(await fs.promises.readFile(cfgFile(n),'utf8')); } catch {}
  // Try legacy filenames
  const legacyNames = LEGACY_CONFIG_NAMES[n] || [];
  for (const legacyName of legacyNames) {
    const legacyPath = path.join(CFG, legacyName);
    try {
      const data = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
      // Found legacy data — migrate it to current filename
      await fs.promises.writeFile(cfgFile(n), JSON.stringify(data, null, 2));
      dbg({ event: 'config_migrated', from: legacyName, to: 'winex-'+n+'.json' });
      return data;
    } catch {}
  }
  return def;
});
ipcMain.handle('cfg:save', async (_,n,d) => { try{await fs.promises.writeFile(cfgFile(n),JSON.stringify(d,null,2));return{ok:1}}catch{return{ok:0}} });

// ══════════════ SESSION SAVE/RESTORE ══════════════
ipcMain.handle('session:save', async (_, data) => {
  try { await fs.promises.writeFile(cfgFile('session'), JSON.stringify(data, null, 2)); return { ok: 1 }; } catch { return { ok: 0 }; }
});
// SYNCHRONOUS save — called from the renderer's beforeunload/pagehide so the session is
// flushed to disk before the window is destroyed (WM close / quit / reload). This is the
// safety net that stops open tabs + history being lost on an unclean close.
ipcMain.on('session:saveSync', (e, data) => {
  try { fs.writeFileSync(cfgFile('session'), JSON.stringify(data, null, 2)); } catch {}
  e.returnValue = 1;
});
ipcMain.handle('session:load', async () => {
  try { return JSON.parse(await fs.promises.readFile(cfgFile('session'), 'utf8')); } catch { return null; }
});

// ══════════════ SMB / NETWORK SHARES (Windows "Map Network Drive"-style) ══════════════
const nodeNet = require('net');

// Quick TCP reachability — far more reliable than ICMP ping, which is commonly blocked while SMB
// (445) is open. Windows probes 445/139 the same way to decide if a server is online.
function tcpProbe(host, port, ms) {
  return new Promise(resolve => {
    const sock = new nodeNet.Socket();
    let done = false;
    const fin = ok => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(ms);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    try { sock.connect(port, host); } catch { fin(false); }
  });
}

// Translate smbclient / mount.cifs output into a friendly, actionable message + a stable code, so the
// UI can react like Windows (re-prompt on a bad password, show "offline", etc.) instead of dumping
// raw NT_STATUS / errno strings at the user.
function classifySmbError(text) {
  const t = (text || '').toUpperCase();
  if (/LOGON_FAILURE|WRONG_PASSWORD|NT_STATUS_LOGON/.test(t)) return { code: 'auth', error: 'Wrong username or password.' };
  if (/ACCOUNT_DISABLED|ACCOUNT_LOCKED_OUT|ACCOUNT_RESTRICTION|INVALID_WORKSTATION|INVALID_LOGON_HOURS/.test(t)) return { code: 'account', error: 'The account is disabled, locked, or not permitted to sign in here.' };
  if (/PASSWORD_EXPIRED|PASSWORD_MUST_CHANGE/.test(t)) return { code: 'pwexpired', error: 'The password has expired on the server.' };
  if (/BAD_NETWORK_NAME|NT_STATUS_OBJECT_NAME_NOT_FOUND/.test(t)) return { code: 'noshare', error: 'That share does not exist on the server.' };
  if (/ACCESS_DENIED|MOUNT ERROR\(13\)|PERMISSION DENIED/.test(t)) return { code: 'denied', error: 'Access denied — check the username/password and that your account can open this share.' };
  if (/CONNECTION_REFUSED|HOST_UNREACHABLE|HOST_DOWN|NETWORK_UNREACHABLE|IO_TIMEOUT|TIMED OUT|UNABLE TO CONNECT|CONNECTION_DISCONNECTED|MOUNT ERROR\(112\)|MOUNT ERROR\(115\)/.test(t)) return { code: 'offline', error: 'Could not reach the server (it may be offline, or SMB is blocked).' };
  if (/PROTOCOL|NEGOTIATE|DIALECT|MOUNT ERROR\(95\)|NOT SUPPORTED/.test(t)) return { code: 'proto', error: 'Could not negotiate a compatible SMB version with the server.' };
  return null;
}

// Write a mode-600 temp credentials file (consumed by both smbclient -A and mount.cifs credentials=)
// and guarantee it's deleted. This keeps the password OUT of the process argv/environment (visible
// in /proc to other users) — the previous code passed password=... on the mount command line.
async function withCredsFile(user, pass, domain, fn) {
  const tmp = path.join(os.tmpdir(), `winex-smbcreds-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const body = `username=${user || ''}\npassword=${pass || ''}\ndomain=${domain || ''}\n`;
  await fs.promises.writeFile(tmp, body, { mode: 0o600 });
  try { return await fn(tmp); } finally { try { await fs.promises.unlink(tmp); } catch {} }
}

// Pre-flight authentication with smbclient. Unlike mount.cifs (which collapses everything to errno
// 13/EACCES), smbclient reports the precise NT_STATUS, so we can tell a wrong password apart from a
// permission problem or a missing share — exactly what Windows shows in its re-prompt dialog.
function smbProbe(loc) {
  const guest = !loc.user;
  return withCredsFile(loc.user, loc.pass, loc.domain, authfile => new Promise(resolve => {
    const args = [`//${loc.host}/${loc.share}`,
      '--option=client min protocol=SMB2', '--option=client max protocol=SMB3',
      '-d', '0', '-c', 'quit'];
    if (guest) args.push('-N', '-U', 'guest'); else args.push('-A', authfile);
    const p = spawn('smbclient', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    p.stdout.on('data', d => so += d); p.stderr.on('data', d => se += d);
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: 0, code: 'offline', error: 'Timed out contacting the server.' }); }, 12000);
    p.on('close', code => {
      clearTimeout(to);
      if (code === 0) return resolve({ ok: 1 });
      const cls = classifySmbError(se + so) || { code: 'unknown', error: (se || so || 'Could not connect to the share.').trim() };
      resolve({ ok: 0, ...cls, raw: (se || so).trim() });
    });
    p.on('error', e => { clearTimeout(to); resolve({ ok: 0, code: 'nosmbclient', error: 'smbclient is not installed.', raw: e.message }); });
  }));
}

// Enumerate the (non-admin) shares on a host — what Windows shows when you type just \\server.
ipcMain.handle('net:enumShares', async (_, loc) => {
  if (!hasCmd('smbclient')) return { ok: 0, code: 'nosmbclient', error: 'smbclient is not installed (sudo apt install smbclient).' };
  const reachable = await tcpProbe(loc.host, 445, 3000) || await tcpProbe(loc.host, 139, 2000);
  if (!reachable) return { ok: 0, code: 'offline', error: `Can't reach ${loc.host} (offline or SMB blocked).` };
  const guest = !loc.user;
  return withCredsFile(loc.user, loc.pass, loc.domain, authfile => new Promise(resolve => {
    const args = ['-L', `//${loc.host}`, '-g', '--option=client min protocol=SMB2', '-d', '0'];
    if (guest) args.push('-N'); else args.push('-A', authfile);
    const p = spawn('smbclient', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    p.stdout.on('data', d => so += d); p.stderr.on('data', d => se += d);
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: 0, code: 'offline', error: 'Timed out listing shares.' }); }, 12000);
    p.on('close', () => {
      clearTimeout(to);
      const shares = [];
      for (const line of so.split('\n')) {
        const parts = line.split('|');                       // "Disk|name|comment"
        if (parts[0] === 'Disk' && parts[1] && !parts[1].endsWith('$')) shares.push(parts[1]);
      }
      if (shares.length) return resolve({ ok: 1, shares });
      const cls = classifySmbError(se + so);
      if (cls) return resolve({ ok: 0, ...cls });
      resolve({ ok: 0, code: 'noshares', error: 'No shares found on this host.' });
    });
    p.on('error', e => { clearTimeout(to); resolve({ ok: 0, error: e.message }); });
  }));
});

// Pre-flight check the renderer calls before mounting → precise, Windows-like feedback.
ipcMain.handle('net:probe', async (_, loc) => {
  if (!loc || loc.type !== 'smb') return { ok: 1 };
  const reachable = await tcpProbe(loc.host, 445, 3000) || await tcpProbe(loc.host, 139, 2000);
  if (!reachable) return { ok: 0, code: 'offline', error: `Can't reach ${loc.host}. The server may be offline, or SMB (port 445) is blocked.` };
  if (!loc.share) return { ok: 1, reachable: true };          // host is up; share enumeration is separate
  if (!hasCmd('smbclient')) return { ok: 1, reachable: true, note: 'smbclient not installed — skipping auth pre-check.' };
  return smbProbe(loc);
});

function runProc(cmd, args, ms) {
  return new Promise(resolve => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    p.stdout.on('data', d => so += d); p.stderr.on('data', d => se += d);
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: 0, error: 'mount timed out (server slow or offline)' }); }, ms);
    p.on('close', code => { clearTimeout(to); code === 0 ? resolve({ ok: 1 }) : resolve({ ok: 0, error: (se || so || `${cmd} exited ${code}`).trim() }); });
    p.on('error', e => { clearTimeout(to); resolve({ ok: 0, error: `${cmd} not found: ${e.message}` }); });
  });
}

// PRIMARY backend: kernel mount.cifs (real path, fast, full SMB3/sec control). Credentials go through
// a 600 file (never argv). We try dialects high→low so the server picks what it supports, emulating
// Windows' auto-negotiation (a hardcoded vers=3.0 fails on servers that only accept 3.1.1 or 2.1).
async function mountCifs(loc) {
  if (!hasCmd('mount.cifs')) return { ok: 0, code: 'nocifs', error: 'cifs-utils is not installed (sudo apt install cifs-utils).' };
  const host = loc.host, share = loc.share, guest = !loc.user;
  const uid = process.getuid(), gid = process.getgid();
  const mountPoint = `/tmp/winex-smb-${host}-${share.replace(/[^a-zA-Z0-9]/g, '_')}`;
  try { fs.mkdirSync(mountPoint, { recursive: true }); } catch {}
  const perf = `uid=${uid},gid=${gid},iocharset=utf8,cache=loose,actimeo=30,rsize=1048576,wsize=1048576`;

  return withCredsFile(loc.user, loc.pass, loc.domain || 'WORKGROUP', async credfile => {
    let lastErr = 'mount failed';
    for (const vers of ['3.1.1', '3.0', '2.1']) {
      const opts = guest
        ? `guest,vers=${vers},${perf}`
        : `credentials=${credfile},vers=${vers},sec=ntlmssp,${perf}`;
      const args = ['-t', 'cifs', `//${host}/${share}`, mountPoint, '-o', opts];
      let r = await runProc('mount', args, 25000);
      if (!r.ok && hasCmd('pkexec') && /only root|permission|must be|not permitted|operation not permitted/i.test(r.error || '')) {
        r = await runProc('pkexec', ['mount', ...args], 60000); // GUI sudo prompt for the privileged step
      }
      if (r.ok) return { ok: 1, mountPath: mountPoint, via: `cifs/${vers}` };
      lastErr = r.error;
      const cls = classifySmbError(r.error);
      // Auth/permission/share errors won't be fixed by trying a different dialect — stop now.
      if (cls && ['auth', 'denied', 'noshare', 'account', 'pwexpired'].includes(cls.code)) return { ok: 0, ...cls, raw: r.error };
    }
    const cls = classifySmbError(lastErr) || { code: 'proto', error: 'Could not mount the share (no compatible SMB dialect / mount.cifs failed).' };
    return { ok: 0, ...cls, raw: lastErr };
  });
}

// FALLBACK backend: GVFS (gio) — userspace, no root prompt, but slower with awkward /run/user paths.
function mountGio(loc, gvfsGuesses, uid) {
  const { host, share, domain } = loc, user = loc.user || '', pass = loc.pass || '';
  const smbUrl = `smb://${host}/${share}`;
  return new Promise(resolve => {
    const args = ['mount']; if (!user) args.push('-a'); args.push(smbUrl);
    const proc = spawn('gio', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '';
    proc.stdout.on('data', d => so += d); proc.stderr.on('data', d => se += d);
    if (user) { try { proc.stdin.write(`${user}\n${domain || 'WORKGROUP'}\n${pass}\n`); proc.stdin.end(); } catch {} }
    const to = setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: 0, code: 'offline', error: 'gio mount timed out (15s).' }); }, 15000);
    proc.on('close', code => {
      clearTimeout(to);
      if (code === 0 || /already mounted/i.test(se)) {
        for (const mp of gvfsGuesses) { try { fs.accessSync(mp); return resolve({ ok: 1, mountPath: mp, via: 'gvfs' }); } catch {} }
        try {
          const base = `/run/user/${uid}/gvfs`;
          const m = fs.readdirSync(base).find(e => e.includes(host) || e.includes(host.toLowerCase()));
          if (m) return resolve({ ok: 1, mountPath: path.join(base, m), via: 'gvfs' });
        } catch {}
        return resolve({ ok: 0, code: 'unknown', error: 'gio mounted but the path was not found under /run/user/' + uid + '/gvfs/.' });
      }
      const cls = classifySmbError(se + so) || { code: 'unknown', error: (se || so || `gio mount failed (code ${code})`).trim() };
      resolve({ ok: 0, ...cls });
    });
    proc.on('error', e => { clearTimeout(to); resolve({ ok: 0, code: 'nogio', error: 'gio not found: ' + e.message }); });
  });
}

async function mountSmb(loc) {
  const host = loc.host, share = loc.share, user = loc.user || '';
  const uid = process.getuid();
  if (!host) return { ok: 0, code: 'badinput', error: 'A server host/IP is required.' };
  if (!share) return { ok: 0, code: 'badinput', error: 'A share name is required (try "Show shares").' };

  // Fast offline check up front so we fail in ~3s instead of hanging on mount timeouts.
  const reachable = await tcpProbe(host, 445, 3000) || await tcpProbe(host, 139, 2000);
  if (!reachable) return { ok: 0, code: 'offline', error: `Can't reach ${host}. The server may be offline, or SMB (port 445) is blocked.` };

  // Reuse an existing GVFS mount if one is already there.
  const gvfsGuesses = [
    `/run/user/${uid}/gvfs/smb-share:server=${host},share=${share}`,
    `/run/user/${uid}/gvfs/smb-share:server=${host.toLowerCase()},share=${share}`,
    `/run/user/${uid}/gvfs/smb-share:server=${host},share=${share},user=${user}`,
  ];
  for (const mp of gvfsGuesses) { try { await fs.promises.access(mp); return { ok: 1, mountPath: mp, via: 'gvfs-existing' }; } catch {} }

  // PRIMARY: mount.cifs. FALLBACK: gio/GVFS.
  const cifs = await mountCifs(loc);
  if (cifs.ok) return cifs;
  const gio = await mountGio(loc, gvfsGuesses, uid);
  if (gio.ok) return gio;

  // Prefer the more specific reason for the UI (auth/denied/noshare over a generic gio failure).
  const specific = (cifs.code && !['nocifs', 'proto', 'unknown'].includes(cifs.code)) ? cifs : gio;
  return { ok: 0, code: specific.code || 'unknown', error: specific.error,
    detail: `mount.cifs: ${cifs.error}\nGVFS: ${gio.error}` };
}

// Network
ipcMain.handle('net:mount', async (_, loc) => {
  if (loc.type === 'smb') return mountSmb(loc);

  if (loc.type === 'nfs') {
    const mountPoint = `/tmp/winex-nfs-${loc.host}-${(loc.share||'').replace(/[^a-zA-Z0-9]/g, '_')}`;
    try { fs.mkdirSync(mountPoint, { recursive: true }); } catch {}
    return new Promise(resolve => {
      exec(`mount -t nfs "${loc.host}:${loc.share}" "${mountPoint}"`, { timeout: 15000 }, (err) => {
        if (!err) resolve({ ok: 1, mountPath: mountPoint });
        else resolve({ ok: 0, error: err.message + '\n\nTip: Try manually: sudo mount -t nfs ' + loc.host + ':' + loc.share + ' ' + mountPoint });
      });
    });
  }

  return { ok: 0, error: 'Unsupported type: ' + loc.type };
});

// Test connectivity to a host
ipcMain.handle('net:test', async (_, host) => {
  return new Promise(resolve => {
    // spawn with an arg array → no shell, so a hostile "host" string can't inject commands
    const p = spawn('ping', ['-c', '1', '-W', '2', String(host || '')], { stdio: 'ignore' });
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: 0, error: 'Host unreachable' }); }, 5000);
    p.on('close', code => { clearTimeout(to); code === 0 ? resolve({ ok: 1, message: 'Host is reachable' }) : resolve({ ok: 0, error: 'Host unreachable' }); });
    p.on('error', () => { clearTimeout(to); resolve({ ok: 0, error: 'ping not available' }); });
  });
});

// List already-mounted gvfs network shares
ipcMain.handle('net:listMounted', async () => {
  const uid = process.getuid();
  const gvfsBase = `/run/user/${uid}/gvfs`;
  try {
    const entries = await fs.promises.readdir(gvfsBase);
    return entries
      .filter(e => e.startsWith('smb-share:') || e.startsWith('nfs:'))
      .map(e => ({ name: e, path: path.join(gvfsBase, e) }));
  } catch { return []; }
});
ipcMain.handle('net:scan', ()=>new Promise(res=>{exec('avahi-browse -t -r _smb._tcp 2>/dev/null | head -40',{timeout:5000},(e,out)=>{if(e)return res([]);const hosts=[];for(const l of out.split('\n')){const h=l.match(/hostname\s*=\s*\[(.+?)\]/);const a=l.match(/address\s*=\s*\[(.+?)\]/);if(h)hosts.push({hostname:h[1].replace(/\.$/,'')});if(a&&hosts.length)hosts[hosts.length-1].address=a[1]}res(hosts)})}));

// Window
ipcMain.handle('win:min', ev => { BrowserWindow.fromWebContents(ev.sender)?.minimize(); });
ipcMain.handle('win:max', ev => { const w=BrowserWindow.fromWebContents(ev.sender); w?.isMaximized()?w.unmaximize():w?.maximize(); });
ipcMain.handle('win:close', ev => { BrowserWindow.fromWebContents(ev.sender)?.close(); });
// True OS-level fullscreen (F11-style). The renderer reacts to the enter/leave-full-screen events
// (wired in wireFullScreen) to hide/show its chrome — so window-manager-triggered F11 works too.
ipcMain.handle('win:setFullScreen', (ev, on) => { const w=BrowserWindow.fromWebContents(ev.sender); if(w) w.setFullScreen(!!on); });
ipcMain.handle('win:toggleFullScreen', ev => { const w=BrowserWindow.fromWebContents(ev.sender); if(w){ const n=!w.isFullScreen(); w.setFullScreen(n); return n; } return false; });
ipcMain.handle('win:isFullScreen', ev => { const w=BrowserWindow.fromWebContents(ev.sender); return w?w.isFullScreen():false; });
ipcMain.handle('dialog:pickFolder', async ev => { const w=BrowserWindow.fromWebContents(ev.sender); const r=await dialog.showOpenDialog(w,{properties:['openDirectory']});return r.canceled?null:r.filePaths[0]; });
ipcMain.on('native-drag', (event, filePath) => { try{const img=nativeImage.createFromPath(filePath);event.sender.startDrag({file:filePath,icon:img.isEmpty()?nativeImage.createEmpty():img.resize({width:64})})}catch{} });

// ══════════════ COPY WITH DUPLICATE DETECTION ══════════════
ipcMain.handle('fs:smartCopy', async (event, srcPath, destDir) => {
  const baseName = path.basename(srcPath);
  const destPath = path.join(destDir, baseName);
  try {
    await fs.promises.access(destPath);
    // File exists — ask user
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Skip', 'Replace', 'Keep Both'],
      defaultId: 2,
      title: 'File already exists',
      message: `"${baseName}" already exists in this folder.`,
      detail: 'What would you like to do?'
    });
    if (r.response === 0) return { ok: 1, action: 'skipped' }; // Skip
    if (r.response === 1) { // Replace
      const st = await fs.promises.stat(srcPath);
      if (st.isDirectory()) await cpR(srcPath, destPath);
      else await universalCopyFile(srcPath, destPath);
      return { ok: 1, action: 'replaced' };
    }
    // Keep Both — add (1), (2) etc
    const ext = path.extname(baseName);
    const nameNoExt = baseName.slice(0, baseName.length - ext.length);
    let n = 1;
    let newDest;
    do { newDest = path.join(destDir, `${nameNoExt} (${n})${ext}`); n++; }
    while (fs.existsSync(newDest));
    const st = await fs.promises.stat(srcPath);
    if (st.isDirectory()) await cpR(srcPath, newDest);
    else await universalCopyFile(srcPath, newDest);
    return { ok: 1, action: 'kept_both', newName: path.basename(newDest) };
  } catch {
    // Doesn't exist — just copy
    try {
      const st = await fs.promises.stat(srcPath);
      if (st.isDirectory()) await cpR(srcPath, destPath);
      else await universalCopyFile(srcPath, destPath);
      // Verify the copy actually succeeded
      try { await fs.promises.access(destPath); } catch { return { ok: 0, error: 'Copy appeared to succeed but destination file not found. The target drive may be full or read-only.' }; }
      return { ok: 1, action: 'copied' };
    } catch (e) { return { ok: 0, error: e.message }; }
  }
});

// ══════════════ RENAME WITH VALIDATION ══════════════
ipcMain.handle('fs:smartRename', async (event, oldPath, newName) => {
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);
  if (oldPath === newPath) return { ok: 1 };
  // Check if target exists
  try {
    await fs.promises.access(newPath);
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Replace'],
      message: `"${newName}" already exists. Replace it?`
    });
    if (r.response === 0) return { ok: 0, cancelled: true };
  } catch {}
  try { await fs.promises.rename(oldPath, newPath); return { ok: 1 }; }
  catch (e) { return { ok: 0, error: e.message }; }
});

// ══════════════ OPEN WITH — list available apps ══════════════
ipcMain.handle('fs:getAppsForFile', async (_, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeResult = await new Promise(resolve => {
    exec(`xdg-mime query filetype "${filePath}"`, { timeout: 3000 }, (e, out) => {
      resolve(e ? '' : out.trim());
    });
  });
  if (!mimeResult) return [];
  // Get default app
  const defaultApp = await new Promise(resolve => {
    exec(`xdg-mime query default "${mimeResult}"`, { timeout: 3000 }, (e, out) => {
      resolve(e ? '' : out.trim());
    });
  });
  // Get all apps that can handle this mime type
  const apps = await new Promise(resolve => {
    exec(`gio mime "${mimeResult}" 2>/dev/null`, { timeout: 3000 }, (e, out) => {
      if (e) return resolve([]);
      const matches = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^\s+(.+\.desktop)\s*$/);
        if (m) matches.push(m[1].trim());
      }
      resolve(matches);
    });
  });
  // Get app names from .desktop files
  const result = [];
  const allApps = [defaultApp, ...apps].filter(Boolean);
  const seen = new Set();
  for (const desktop of allApps) {
    if (seen.has(desktop)) continue;
    seen.add(desktop);
    const name = await new Promise(resolve => {
      const paths = [
        `/usr/share/applications/${desktop}`,
        `${HOME}/.local/share/applications/${desktop}`,
        `/var/lib/flatpak/exports/share/applications/${desktop}`,
        `/var/lib/snapd/desktop/applications/${desktop}`
      ];
      for (const p of paths) {
        try {
          const content = fs.readFileSync(p, 'utf8');
          const nameMatch = content.match(/^Name=(.+)$/m);
          const execMatch = content.match(/^Exec=(.+)$/m);
          if (nameMatch) {
            resolve({ name: nameMatch[1], desktop, exec: execMatch ? execMatch[1] : '', isDefault: desktop === defaultApp });
            return;
          }
        } catch {}
      }
      resolve({ name: desktop.replace('.desktop', ''), desktop, exec: '', isDefault: desktop === defaultApp });
    });
    result.push(name);
  }
  return result;
});

ipcMain.handle('fs:openWith', async (_, filePath, desktopFile) => {
  return new Promise(resolve => {
    exec(`gtk-launch "${desktopFile}" "${filePath}"`, { timeout: 5000 }, (e) => {
      if (e) exec(`xdg-open "${filePath}"`, { timeout: 5000 });
      resolve({ ok: 1 });
    });
  });
});

// ══════════════ PAGINATED READDIR (prevents freeze on huge folders) ══════════════
ipcMain.handle('fs:readdirPaged', async (_, dirPath, offset, limit) => {
  try {
    const filtered = (await fs.promises.readdir(dirPath, { withFileTypes: true })).filter(d => !d.name.startsWith('.'));
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const results = await Promise.all(page.map(d => buildEntry(dirPath, d)));
    return { ok: 1, entries: results, total, hasMore: offset + limit < total };
  } catch (e) { return { ok: 0, error: e.message }; }
});

// ══════════════ PERSISTENT MEMORY (bookmarks, favourites, pinned folders) ══════════════
// This file is version-agnostic — future versions read the same file
const MEMORY_FILE = path.join(CFG, 'fluent-explorer-memory.json');

ipcMain.handle('memory:load', async () => {
  let memory = { version: 1, favourites: [], bookmarks: [], pinnedFolders: [], cachedFolders: [], recentPaths: [] };
  try { memory = JSON.parse(await fs.promises.readFile(MEMORY_FILE, 'utf8')); } catch {}
  if (!memory.favourites) memory.favourites = [];
  if (!memory.bookmarks) memory.bookmarks = [];

  // If memory is empty, try to recover from ALL legacy bookmark files
  if (!memory.favourites.length && !memory.bookmarks.length) {
    const legacyFiles = [
      'winex-bookmarks.json',
      'win-explorer-bookmarks.json',
    ];
    for (const fname of legacyFiles) {
      try {
        const data = JSON.parse(await fs.promises.readFile(path.join(CFG, fname), 'utf8'));
        if (data.favourites && data.favourites.length) {
          memory.favourites = [...new Set([...memory.favourites, ...data.favourites])];
        }
        if (data.bookmarks && data.bookmarks.length) {
          memory.bookmarks = [...new Set([...memory.bookmarks, ...data.bookmarks])];
        }
      } catch {}
    }
    // Save recovered data
    if (memory.favourites.length || memory.bookmarks.length) {
      try { await fs.promises.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2)); } catch {}
      dbg({ event: 'bookmarks_recovered', favourites: memory.favourites.length, bookmarks: memory.bookmarks.length });
    }
  }
  return memory;
});

ipcMain.handle('memory:save', async (_, data) => {
  try {
    data.version = 1;
    data.lastSaved = new Date().toISOString();
    await fs.promises.writeFile(MEMORY_FILE, JSON.stringify(data, null, 2));
    return { ok: 1 };
  } catch (e) { return { ok: 0, error: e.message }; }
});

// Mark a folder for persistent thumb caching (pre-generate all thumbs)
ipcMain.handle('memory:cacheFolder', async (_, folderPath) => {
  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    let count = 0;
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isDirectory()) continue;
      const ext = path.extname(e.name).toLowerCase().slice(1);
      if (!IMG_EXT.has(ext)) continue;
      const full = path.join(folderPath, e.name);
      const fp = normPath(full);
      if (thumbMemCache.has(fp)) { count++; continue; }
      const hash = hashPath(fp);
      const cp = path.join(CACHE, hash + '.jpg');
      try { await fs.promises.access(cp); thumbMemCache.set(fp, 'localthumb://' + cp); count++; continue; } catch {}
      try {
        const img = nativeImage.createFromPath(fp);
        if (!img.isEmpty()) {
          const resized = img.resize({ width: 200, quality: 'good' });
          await fs.promises.writeFile(cp, resized.toJPEG(75));
          thumbMemCache.set(fp, 'localthumb://' + cp);
          count++;
        }
      } catch {}
    }
    return { ok: 1, cached: count };
  } catch (e) { return { ok: 0, error: e.message }; }
});

// Check for new files in a cached folder (incremental update)
ipcMain.handle('memory:syncFolder', async (_, folderPath) => {
  try {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    let newFiles = 0;
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isDirectory()) continue;
      const ext = path.extname(e.name).toLowerCase().slice(1);
      if (!IMG_EXT.has(ext)) continue;
      const full = normPath(path.join(folderPath, e.name));
      if (thumbMemCache.has(full)) continue;
      const hash = hashPath(full);
      const cp = path.join(CACHE, hash + '.jpg');
      try { await fs.promises.access(cp); thumbMemCache.set(full, 'localthumb://' + cp); continue; } catch {}
      // New file — generate thumb
      try {
        const img = nativeImage.createFromPath(full);
        if (!img.isEmpty()) {
          const resized = img.resize({ width: 200, quality: 'good' });
          await fs.promises.writeFile(cp, resized.toJPEG(75));
          thumbMemCache.set(full, 'localthumb://' + cp);
          newFiles++;
        }
      } catch {}
    }
    return { ok: 1, newFiles };
  } catch (e) { return { ok: 0, error: e.message }; }
});
