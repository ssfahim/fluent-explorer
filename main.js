const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn, execSync } = require('child_process');

const HOME = os.homedir();
const CACHE = path.join(HOME, '.cache', 'winex-thumbs');
const CFG = path.join(HOME, '.config');
try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}

const IMG_EXT = new Set(['jpg','jpeg','png','gif','bmp','webp','svg','ico','tiff','avif','heic']);
const VID_EXT = new Set(['mp4','avi','mkv','mov','webm','flv','wmv','m4v','mpg','mpeg','3gp']);

let explorerWin = null;
let photosWins = new Set();
const isPhotosOnly = process.argv.includes('--photos');

// ══════════════ GLOBAL STATE ══════════════
let globalClipboard = { paths: [], action: '' };
// Stored sorted image list for Photos to pick up (eliminates race condition)
let pendingPhotosData = null; // { sortedPaths:[], startImage:'' }

ipcMain.handle('clip:set', (_, d) => { globalClipboard = d; });
ipcMain.handle('clip:get', () => globalClipboard);

// Photos requests the sorted list — no race condition
ipcMain.handle('photos:getSortedList', () => {
  const data = pendingPhotosData;
  pendingPhotosData = null; // consume it
  return data;
});

function createExplorerWindow() {
  explorerWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 500, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, 'icon.svg'), backgroundColor: '#f3f3f3'
  });
  explorerWin.loadFile('explorer.html');
  explorerWin.on('closed', () => { explorerWin = null; });
}

function createPhotosWindow(folder, imagePath, sortedImagePaths) {
  // Store the sorted list BEFORE creating the window — Photos will request it on init
  if (sortedImagePaths && sortedImagePaths.length) {
    pendingPhotosData = { sortedPaths: sortedImagePaths, startImage: imagePath };
  }
  const win = new BrowserWindow({
    width: 1100, height: 750, minWidth: 700, minHeight: 500, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    icon: path.join(__dirname, 'icon.svg'), backgroundColor: '#111111'
  });
  win.loadFile('photos.html', { query: { folder: folder || '', image: imagePath || '' } });
  photosWins.add(win);
  win.on('closed', () => { photosWins.delete(win); });
}

app.whenReady().then(() => {
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
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('app:openPhotos', (_, folder, imagePath, sortedImagePaths) => {
  createPhotosWindow(folder, imagePath, sortedImagePaths);
  return { ok: 1 };
});

// ══════════════ FILESYSTEM ══════════════
ipcMain.handle('fs:readdir', async (_, dirPath) => {
  try {
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const results = [];
    await Promise.all(dirents.filter(d => !d.name.startsWith('.')).map(async d => {
      const full = path.join(dirPath, d.name);
      try {
        const st = await fs.promises.stat(full);
        const ext = path.extname(d.name).toLowerCase().slice(1);
        results.push({ name: d.name, path: full, isDirectory: d.isDirectory(), isImage: IMG_EXT.has(ext), isVideo: VID_EXT.has(ext), ext, size: st.size, modified: st.mtime.toISOString().split('T')[0], modifiedMs: st.mtime.getTime(), createdMs: st.birthtime.getTime(), permissions: (st.mode & 0o777).toString(8) });
      } catch {}
    }));
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

// ══════════════ THUMBNAILS — RESOURCE-AWARE ENGINE ══════════════
const thumbMemCache = new Map();
const DEBUG_LOG = path.join(HOME, '.cache', 'winex-debug.log');
const PERF_LOG = path.join(HOME, '.cache', 'winex-performance.log');
let debugLogStream = null;
let perfLogStream = null;

function dbg(obj) {
  if (!debugLogStream) {
    try { debugLogStream = fs.createWriteStream(DEBUG_LOG, { flags: 'a' }); } catch { return; }
    debugLogStream.write(JSON.stringify({ event: 'app_start', version: 'v1.3-resource-aware', ts: Date.now() }) + '\n');
  }
  debugLogStream.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
}
function perfLog(obj) {
  if (!perfLogStream) {
    try { perfLogStream = fs.createWriteStream(PERF_LOG, { flags: 'a' }); } catch { return; }
  }
  perfLogStream.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
}

function normPath(p) { return path.resolve(p); }
function hashPath(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

const CACHE_VERSION_FILE = path.join(CACHE, '.cache_version');
try { if (fs.readFileSync(CACHE_VERSION_FILE, 'utf8').trim() !== '3') throw 0; }
catch { try { for (const f of fs.readdirSync(CACHE)) { if (f.endsWith('.jpg')) fs.unlinkSync(path.join(CACHE, f)); } } catch {} fs.writeFileSync(CACHE_VERSION_FILE, '3'); }

const RL = { maxRssMB: 900, maxLoadPct: 75, maxPerSec: 8, minDelayMs: 125, concurrency: 1, maxQueue: 100 };
let lastThumbTime = 0, thumbsThisSec = 0, lastSecReset = 0, thumbPaused = false, activeJobs = 0;
const thumbQueue = [];

function getResUsage() {
  const m = process.memoryUsage();
  return { rssMB: Math.round(m.rss/1048576), heapMB: Math.round(m.heapUsed/1048576), loadPct: Math.round(os.loadavg()[0]/os.cpus().length*100), freeMB: Math.round(os.freemem()/1048576), totalMB: Math.round(os.totalmem()/1048576), qLen: thumbQueue.length };
}

function shouldPause() {
  const r = getResUsage();
  const now = Date.now();
  if (Math.floor(now/1000) !== lastSecReset) { thumbsThisSec = 0; lastSecReset = Math.floor(now/1000); }
  const bad = r.rssMB > RL.maxRssMB || r.loadPct > RL.maxLoadPct || r.freeMB < 500 || thumbsThisSec >= RL.maxPerSec;
  if (bad && !thumbPaused) { thumbPaused = true; perfLog({ event: 'thumb_paused', ...r }); }
  if (!bad && thumbPaused) { thumbPaused = false; perfLog({ event: 'thumb_resumed', ...r }); }
  return bad;
}

async function runQueue() {
  if (activeJobs >= RL.concurrency || !thumbQueue.length) return;
  if (shouldPause()) { setTimeout(runQueue, 500); return; }
  const elapsed = Date.now() - lastThumbTime;
  if (elapsed < RL.minDelayMs) { setTimeout(runQueue, RL.minDelayMs - elapsed); return; }
  const job = thumbQueue.shift();
  activeJobs++; lastThumbTime = Date.now(); thumbsThisSec++;
  try { await job(); } catch {}
  activeJobs--;
  if (thumbsThisSec === 1) perfLog({ event: 'res_check', ...getResUsage() });
  if (thumbQueue.length) setTimeout(runQueue, 10);
}

ipcMain.handle('fs:getThumb', (_, filePath) => {
  const fp = normPath(filePath);
  if (thumbMemCache.has(fp)) return thumbMemCache.get(fp);
  if (thumbQueue.length >= RL.maxQueue) return null;
  return new Promise(resolve => {
    thumbQueue.push(async () => {
      try {
        const h = hashPath(fp), cp = path.join(CACHE, h + '.jpg');
        try { await fs.promises.access(cp); const u = 'localthumb://' + cp; thumbMemCache.set(fp, u); resolve(u); return; } catch {}
        const r = getResUsage();
        if (r.rssMB > RL.maxRssMB + 200 || r.freeMB < 200) { resolve(null); return; }
        const img = nativeImage.createFromPath(fp);
        if (img.isEmpty()) { thumbMemCache.set(fp, null); resolve(null); return; }
        const resized = img.resize({ width: 200, quality: 'good' });
        await fs.promises.writeFile(cp, resized.toJPEG(75));
        const u = 'localthumb://' + cp;
        thumbMemCache.set(fp, u); dbg({ event: 'thumb_generated', path: fp, hash: h }); resolve(u);
      } catch { thumbMemCache.set(fp, null); resolve(null); }
    });
    runQueue();
  });
});

ipcMain.handle('fs:getVideoThumb', (_, vp) => {
  const fp = normPath(vp);
  if (thumbMemCache.has(fp)) return Promise.resolve(thumbMemCache.get(fp));
  if (thumbQueue.length >= RL.maxQueue) return Promise.resolve(null);
  const h = hashPath(fp), cp = path.join(CACHE, 'v_' + h + '.jpg');
  return new Promise(resolve => {
    thumbQueue.push(async () => {
      try { await fs.promises.access(cp); const u='localthumb://'+cp; thumbMemCache.set(fp,u); resolve(u); return; } catch {}
      try { execSync('which ffmpeg',{stdio:'ignore'}); } catch { resolve(null); return; }
      await new Promise(res2 => {
        const p=spawn('ffmpeg',['-i',fp,'-ss','2','-vframes','1','-vf','scale=200:-1','-q:v','8','-y',cp],{stdio:'ignore',timeout:6000});
        p.on('close',code=>{const u=code===0?'localthumb://'+cp:null;thumbMemCache.set(fp,u);resolve(u);res2()});
        p.on('error',()=>{resolve(null);res2()});
        setTimeout(()=>{try{p.kill()}catch{};res2()},6000);
      });
    });
    runQueue();
  });
});

ipcMain.handle('fs:imageUrl', (_, p) => 'localthumb://' + normPath(p));
ipcMain.handle('fs:getCachedThumbs', async (_, paths) => { const r = {}; for (const p of paths) { const np = normPath(p); if (thumbMemCache.has(np)) r[p] = thumbMemCache.get(np); } return r; });
ipcMain.handle('fs:getResourceUsage', () => getResUsage());
ipcMain.handle('fs:clearThumbQueue', () => { const c = thumbQueue.length; thumbQueue.length = 0; perfLog({ event: 'queue_cleared', cleared: c }); return { cleared: c }; });

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
ipcMain.handle('cfg:load', async (_,n,def) => { try{return JSON.parse(await fs.promises.readFile(cfgFile(n),'utf8'))}catch{return def} });
ipcMain.handle('cfg:save', async (_,n,d) => { try{await fs.promises.writeFile(cfgFile(n),JSON.stringify(d,null,2));return{ok:1}}catch{return{ok:0}} });

// ══════════════ SESSION SAVE/RESTORE ══════════════
ipcMain.handle('session:save', async (_, data) => {
  try { await fs.promises.writeFile(cfgFile('session'), JSON.stringify(data, null, 2)); return { ok: 1 }; } catch { return { ok: 0 }; }
});
ipcMain.handle('session:load', async () => {
  try { return JSON.parse(await fs.promises.readFile(cfgFile('session'), 'utf8')); } catch { return null; }
});

// Network
ipcMain.handle('net:mount', async (_, loc) => {
  if (loc.type === 'smb') {
    const host = loc.host;
    const share = loc.share;
    const user = loc.user || '';
    const pass = loc.pass || '';
    const domain = loc.domain || 'WORKGROUP';
    const smbUrl = `smb://${host}/${share}`;

    // First check if already mounted via gvfs
    const uid = process.getuid();
    const possiblePaths = [
      `/run/user/${uid}/gvfs/smb-share:server=${host},share=${share}`,
      `/run/user/${uid}/gvfs/smb-share:server=${host.toLowerCase()},share=${share}`,
      `/run/user/${uid}/gvfs/smb-share:server=${host},share=${share},user=${user}`,
    ];
    for (const mp of possiblePaths) {
      try { await fs.promises.access(mp); return { ok: 1, mountPath: mp }; } catch {}
    }

    // Method 1: gio mount with credentials piped via stdin
    // gio mount prompts: User [user]: / Domain [WORKGROUP]: / Password:
    const gioResult = await new Promise(resolve => {
      let args = ['mount'];
      if (!user) args.push('-a'); // anonymous if no user
      args.push(smbUrl);

      const proc = spawn('gio', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());

      if (user) {
        // Pipe credentials in the format gio expects:
        // echo -e "user\ndomain\npassword\n" | gio mount smb://...
        proc.stdin.write(user + '\n');
        proc.stdin.write(domain + '\n');
        proc.stdin.write(pass + '\n');
        proc.stdin.end();
      }

      const timeout = setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: 0, error: 'Connection timed out (15s)' }); }, 15000);

      proc.on('close', code => {
        clearTimeout(timeout);
        if (code === 0) {
          // Find the actual mount path
          for (const mp of possiblePaths) {
            try { fs.accessSync(mp); resolve({ ok: 1, mountPath: mp }); return; } catch {}
          }
          // Try listing gvfs mounts to find it
          try {
            const gvfsBase = `/run/user/${uid}/gvfs`;
            const entries = fs.readdirSync(gvfsBase);
            const match = entries.find(e => e.includes(host) || e.includes(host.toLowerCase()));
            if (match) { resolve({ ok: 1, mountPath: path.join(gvfsBase, match) }); return; }
          } catch {}
          resolve({ ok: 0, error: 'Mounted but could not find gvfs path. Check /run/user/' + uid + '/gvfs/' });
        } else {
          let errMsg = stderr.trim() || stdout.trim() || 'gio mount failed (code ' + code + ')';
          // Clean up common error messages
          if (errMsg.includes('Location is already mounted')) {
            // It's already mounted, find the path
            for (const mp of possiblePaths) {
              try { fs.accessSync(mp); resolve({ ok: 1, mountPath: mp }); return; } catch {}
            }
          }
          resolve({ ok: 0, error: errMsg, method: 'gio' });
        }
      });
      proc.on('error', e => { clearTimeout(timeout); resolve({ ok: 0, error: 'gio not found: ' + e.message }); });
    });

    if (gioResult.ok) return gioResult;

    // Method 2: mount.cifs fallback (needs cifs-utils installed, may need sudo)
    // Try without sudo first (user mounts to /tmp)
    const mountPoint = `/tmp/winex-smb-${host}-${share.replace(/[^a-zA-Z0-9]/g, '_')}`;
    try { fs.mkdirSync(mountPoint, { recursive: true }); } catch {}

    const cifsResult = await new Promise(resolve => {
      const opts = user
        ? `username=${user},password=${pass},workgroup=${domain},uid=${uid},gid=${process.getgid()}`
        : `guest,uid=${uid},gid=${process.getgid()}`;

      exec(`mount -t cifs "//${host}/${share}" "${mountPoint}" -o ${opts}`, { timeout: 15000 }, (err, stdout, stderr) => {
        if (!err) { resolve({ ok: 1, mountPath: mountPoint }); }
        else { resolve({ ok: 0, error: stderr || err.message, method: 'cifs' }); }
      });
    });

    if (cifsResult.ok) return cifsResult;

    // Return combined error info
    return { ok: 0, error: `gio: ${gioResult.error}\n\nCIFS fallback: ${cifsResult.error}\n\nTips:\n- Check if the server is reachable: ping ${host}\n- Check if smbclient works: smbclient -L ${host} -U ${user || 'guest'}%${pass}\n- Install cifs-utils: sudo apt install cifs-utils\n- For guest access, leave username empty` };
  }

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
    exec(`ping -c 1 -W 2 ${host} 2>&1`, { timeout: 5000 }, (err, out) => {
      if (!err) resolve({ ok: 1, message: 'Host is reachable' });
      else resolve({ ok: 0, error: 'Host unreachable' });
    });
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
    const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const filtered = dirents.filter(d => !d.name.startsWith('.'));
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const results = [];
    await Promise.all(page.map(async d => {
      const full = path.join(dirPath, d.name);
      try {
        const st = await fs.promises.stat(full);
        const ext = path.extname(d.name).toLowerCase().slice(1);
        results.push({ name: d.name, path: full, isDirectory: d.isDirectory(), isImage: IMG_EXT.has(ext), isVideo: VID_EXT.has(ext), ext, size: st.size, modified: st.mtime.toISOString().split('T')[0], modifiedMs: st.mtime.getTime(), createdMs: st.birthtime.getTime(), permissions: (st.mode & 0o777).toString(8) });
      } catch {}
    }));
    return { ok: 1, entries: results, total, hasMore: offset + limit < total };
  } catch (e) { return { ok: 0, error: e.message }; }
});

// ══════════════ PERSISTENT MEMORY (bookmarks, favourites, pinned folders) ══════════════
// This file is version-agnostic — future versions read the same file
const MEMORY_FILE = path.join(CFG, 'fluent-explorer-memory.json');

ipcMain.handle('memory:load', async () => {
  try { return JSON.parse(await fs.promises.readFile(MEMORY_FILE, 'utf8')); }
  catch { return { version: 1, favourites: [], bookmarks: [], pinnedFolders: [], cachedFolders: [], recentPaths: [] }; }
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
