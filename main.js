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

// ══════════════ THUMBNAILS ══════════════
const thumbMemCache = new Map();
const DEBUG_LOG = path.join(HOME, '.cache', 'winex-debug.log');
let debugLogStream = null;

function dbg(obj) {
  if (!debugLogStream) {
    try { debugLogStream = fs.createWriteStream(DEBUG_LOG, { flags: 'a' }); } catch { return; }
    debugLogStream.write(JSON.stringify({ event: 'app_start', version: 'v9-fixed-sha256', ts: Date.now() }) + '\n');
  }
  debugLogStream.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
}

// Normalize path to prevent cache key collisions
function normPath(p) { return path.resolve(p); }

// PROPER hash — SHA-256. The old base64url.slice(0,80) caused collisions
// for files in the same directory with similar names.
function hashPath(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

// Purge old corrupt cache on first run of v9 (one-time migration)
const CACHE_VERSION_FILE = path.join(CACHE, '.cache_version');
try {
  const ver = fs.readFileSync(CACHE_VERSION_FILE, 'utf8').trim();
  if (ver !== '2') throw new Error('old');
} catch {
  // Delete all old cached thumbs (they used truncated base64 = collisions)
  try {
    const old = fs.readdirSync(CACHE);
    for (const f of old) { if (f.endsWith('.jpg')) fs.unlinkSync(path.join(CACHE, f)); }
  } catch {}
  fs.writeFileSync(CACHE_VERSION_FILE, '2');
}

// Concurrency limiter — max 3 thumb generations at once to prevent freeze
let activeThumbJobs = 0;
const THUMB_CONCURRENCY = 3;
const thumbQueue = [];

function runThumbQueue() {
  while (activeThumbJobs < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    activeThumbJobs++;
    job().finally(() => { activeThumbJobs--; runThumbQueue(); });
  }
}

ipcMain.handle('fs:getThumb', (_, filePath) => {
  const fp = normPath(filePath);
  if (thumbMemCache.has(fp)) {
    dbg({ event: 'thumb_cache_hit', path: fp, source: 'memory' });
    return thumbMemCache.get(fp);
  }
  return new Promise(resolve => {
    const job = async () => {
      try {
        const hash = hashPath(fp);
        const cp = path.join(CACHE, hash + '.jpg');
        try {
          await fs.promises.access(cp);
          const url = 'localthumb://' + cp;
          thumbMemCache.set(fp, url);
          dbg({ event: 'thumb_cache_hit', path: fp, source: 'disk', hash });
          resolve(url);
          return;
        } catch {}
        const img = nativeImage.createFromPath(fp);
        if (img.isEmpty()) { thumbMemCache.set(fp, null); dbg({ event: 'thumb_empty', path: fp }); resolve(null); return; }
        const resized = img.resize({ width: 200, quality: 'good' });
        await fs.promises.writeFile(cp, resized.toJPEG(75));
        const url = 'localthumb://' + cp;
        thumbMemCache.set(fp, url);
        dbg({ event: 'thumb_generated', path: fp, hash });
        resolve(url);
      } catch (e) { thumbMemCache.set(fp, null); dbg({ event: 'thumb_error', path: fp, error: e.message }); resolve(null); }
    };
    thumbQueue.push(job);
    runThumbQueue();
  });
});

ipcMain.handle('fs:getVideoThumb', (_, videoPath) => {
  const fp = normPath(videoPath);
  if (thumbMemCache.has(fp)) return Promise.resolve(thumbMemCache.get(fp));
  const hash = hashPath(fp);
  const cp = path.join(CACHE, 'v_' + hash + '.jpg');
  return new Promise(resolve => {
    const job = async () => {
      try { await fs.promises.access(cp); const url='localthumb://'+cp; thumbMemCache.set(fp,url); resolve(url); return; } catch {}
      try { execSync('which ffmpeg',{stdio:'ignore'}); } catch { resolve(null); return; }
      const p=spawn('ffmpeg',['-i',fp,'-ss','2','-vframes','1','-vf','scale=200:-1','-q:v','8','-y',cp],{stdio:'ignore',timeout:6000});
      p.on('close',code=>{const url=code===0?'localthumb://'+cp:null;thumbMemCache.set(fp,url);resolve(url)});
      p.on('error',()=>resolve(null));
      setTimeout(()=>{try{p.kill()}catch{}},6000);
    };
    thumbQueue.push(job);
    runThumbQueue();
  });
});

ipcMain.handle('fs:imageUrl', (_, p) => 'localthumb://' + normPath(p));

ipcMain.handle('fs:getCachedThumbs', async (_, paths) => {
  const result = {};
  for (const p of paths) {
    const np = normPath(p);
    if (thumbMemCache.has(np)) result[p] = thumbMemCache.get(np);
  }
  return result;
});

// ══════════════ STANDARD FS OPS ══════════════
ipcMain.handle('fs:homedir', () => HOME);
ipcMain.handle('fs:quickPaths', () => ({ home: HOME, desktop: path.join(HOME,'Desktop'), documents: path.join(HOME,'Documents'), downloads: path.join(HOME,'Downloads'), music: path.join(HOME,'Music'), pictures: path.join(HOME,'Pictures'), videos: path.join(HOME,'Videos'), trash: path.join(HOME,'.local/share/Trash/files') }));
ipcMain.handle('fs:openFile', async (_,p) => { try{await shell.openPath(p);return{ok:1}}catch(e){return{ok:0,error:e.message}} });
ipcMain.handle('fs:trash', async (_,p) => { try{await shell.trashItem(p);return{ok:1}}catch(e){return{ok:0,error:e.message}} });
ipcMain.handle('fs:rename', async (_,o,n) => { try{await fs.promises.rename(o,path.join(path.dirname(o),n));return{ok:1}}catch(e){return{ok:0,error:e.message}} });
ipcMain.handle('fs:copy', async (_,s,d) => { try{const dest=path.join(d,path.basename(s));const st=await fs.promises.stat(s);if(st.isDirectory())await cpR(s,dest);else await fs.promises.copyFile(s,dest);return{ok:1}}catch(e){return{ok:0,error:e.message}} });
async function cpR(s,d){await fs.promises.mkdir(d,{recursive:true});for(const e of await fs.promises.readdir(s,{withFileTypes:true})){const sp=path.join(s,e.name),dp=path.join(d,e.name);if(e.isDirectory())await cpR(sp,dp);else await fs.promises.copyFile(sp,dp)}}
ipcMain.handle('fs:copyFile', async (_,s,d) => { try{await fs.promises.copyFile(s,path.join(d,path.basename(s)));return{ok:1}}catch(e){return{ok:0,error:e.message}} });
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
