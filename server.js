const os = require('os');

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { exec, execFile, spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || process.argv[2] || 3000;
const RESTART_DELAY = parseInt(process.env.RESTART_DELAY || '0', 10);
const BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
const UPLOADS = path.join(BASE, 'uploads');
const PUBLIC_DIR = process.pkg ? path.join(__dirname, 'public') : path.join(BASE, 'public');

// Video quality presets for transcoding
const QUALITY_PRESETS = {
  copy: { name: '快速转封装', vbitrate: 0, abitrate: 0, scale: null },
  '1080p-high': { name: '1080p 高画质', vbitrate: 8000, abitrate: 128, scale: 1080 },
  '1080p': { name: '1080p 省空间', vbitrate: 4000, abitrate: 128, scale: 1080 },
  '720p': { name: '720p 手机', vbitrate: 2000, abitrate: 96, scale: 720 },
  '480p': { name: '480p 最小', vbitrate: 1000, abitrate: 64, scale: 480 }
};
const NULL_DEV = os.platform() === 'win32' ? 'NUL' : '/dev/null';
const TRICKS_FILE = path.join(BASE, 'data', 'tricks.json');
const CATS_FILE = path.join(BASE, 'data', 'categories.json');
const WHITELIST_FILE = path.join(BASE, 'data', 'whitelist.txt');
const THUMB_TIMES_FILE = path.join(BASE, 'data', 'thumb-times.json');
const RESOURCE_LINKS_FILE = path.join(BASE, 'data', 'resource-links.json');

// ── Whitelist ──
function readWhitelist() {
  try {
    const txt = fs.readFileSync(WHITELIST_FILE, 'utf-8');
    return txt.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}
function pathIsAllowed(requestedPath) {
  const wl = readWhitelist();
  if (wl.length === 0) return true; // no whitelist = allow all
  const norm = path.resolve(requestedPath);
  return wl.some(allowed => {
    const a = path.resolve(allowed);
    return norm === a || norm.startsWith(a + path.sep);
  });
}

const funnyNames = [
  '地板杀手','膝盖终结者','重力叛逆者','水泥冲浪王','空中飞人',
  '刹车失灵','轮子成精','马路小旋风','摔倒艺术家','风一样的少年',
  '地心引力挑战者','360度懵逼侠','翻滚吧蛋蛋','闪电小蜗牛','无敌风火轮',
  '膝盖保险到期','地球自转加速器','半空中的咸鱼','刹车在哪','今天不摔了',
  '物理老师哭了','牛顿棺材板','轮胎想飞','地面摩擦战士','我是来滑的'
];

for (const d of ['uploads/videos', 'uploads/thumbnails', 'uploads/trimmed', 'data']) {
  const p = path.join(BASE, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ── DB helpers ──
function readTricks() {
  try { return JSON.parse(fs.readFileSync(TRICKS_FILE, 'utf-8')); }
  catch { return []; }
}
function writeTricks(d) { fs.writeFileSync(TRICKS_FILE, JSON.stringify(d, null, 2)); }

function readCats() {
  try { return JSON.parse(fs.readFileSync(CATS_FILE, 'utf-8')); }
  catch { return []; }
}
function writeCats(d) { fs.writeFileSync(CATS_FILE, JSON.stringify(d, null, 2)); }

function getDescendantIds(cats, parentId) {
  const ids = [parentId];
  for (const child of cats.filter(c => c.parentId === parentId))
    ids.push(...getDescendantIds(cats, child.id));
  return ids;
}

// ── Thumbnail ──
function generateThumbnail(videoPath, thumbName) {
  return new Promise(resolve => {
    const tp = path.join(UPLOADS, 'thumbnails', thumbName);
    execFile('ffmpeg', [
      '-y', '-ss', '00:00:01', '-i', videoPath,
      '-vframes', '1', '-vf', 'scale=480:-1', tp
    ], err => resolve(err ? null : `/uploads/thumbnails/${thumbName}`));
  });
}

// ── Multer ──
const storage = multer.diskStorage({
  destination: (_req, _f, cb) => cb(null, path.join(UPLOADS, 'videos')),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function multerErrHandler(err, req, res, next) {
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: '上传错误: ' + err.message });
  next(err);
}

// ── App ──
const app = express();
app.use(express.json({ limit: '10mb' }));

// Root → server browsing mode (most used)
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'server.html')));
app.get('/server.html', (_req, res) => res.redirect(301, '/'));

app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS));

// ════════════════════════════
//  Category API
// ════════════════════════════
app.get('/api/categories', (_req, res) => res.json(readCats()));

app.post('/api/categories', (req, res) => {
  const { name, parentId } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '请输入分类名称' });
  const cats = readCats();
  if (parentId && !cats.find(c => c.id === parentId))
    return res.status(400).json({ error: '父分类不存在' });
  const cat = { id: randomUUID(), name: name.trim(), parentId: parentId || null, createdAt: new Date().toISOString() };
  cats.push(cat);
  writeCats(cats);
  res.json(cat);
});

// Rename category
app.patch('/api/categories/:id', (req, res) => {
  const cats = readCats();
  const cat = cats.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: '未找到' });
  if (req.body.name?.trim()) cat.name = req.body.name.trim();
  if (req.body.parentId !== undefined) cat.parentId = req.body.parentId || null;
  writeCats(cats);
  res.json(cat);
});

app.delete('/api/categories/:id', (req, res) => {
  let cats = readCats();
  const tricks = readTricks();
  const toRemove = new Set(getDescendantIds(cats, req.params.id));
  let changed = false;
  for (const t of tricks) {
    if (toRemove.has(t.category)) { t.category = null; changed = true; }
  }
  if (changed) writeTricks(tricks);
  cats = cats.filter(c => !toRemove.has(c.id));
  writeCats(cats);
  res.json({ success: true });
});

// ════════════════════════════
//  Tricks API
// ════════════════════════════
app.get('/api/tricks', (req, res) => {
  const db = readTricks();
  let changed = false;
  for (const t of db) {
    if (t.fileSize == null) {
      try { t.fileSize = fs.statSync(path.join(BASE, t.videoPath)).size; changed = true; } catch {}
    }
  }
  if (changed) writeTricks(db);
  if (req.query.category) {
    const ids = getDescendantIds(readCats(), req.query.category);
    const filtered = db.filter(t => ids.includes(t.category));
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json(filtered);
  }
  db.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(db);
});

// Upload (category defaults to null)
app.post('/api/tricks', upload.single('file'), multerErrHandler, async (req, res) => {
  try {
    const { name, notes } = req.body;
    if (!req.file) return res.status(400).json({ error: '未上传文件' });
    const trickName = name?.trim() || funnyNames[Math.floor(Math.random() * funnyNames.length)];

    const ext = path.extname(req.file.filename).toLowerCase();
    const mediaType = ext === '.gif' ? 'gif' : 'video';
    const videoPath = `/uploads/videos/${req.file.filename}`;

    let thumbnail = null;
    if (mediaType === 'video') {
      thumbnail = await generateThumbnail(req.file.path, req.file.filename.replace(ext, '.jpg'));
    }

    const trick = {
      id: randomUUID(),
      name: trickName,
      category: null,
      mediaType,
      videoPath,
      fileSize: req.file.size,
      thumbnail,
      clips: [],
      notes: notes?.trim() || '',
      originalName: req.file.originalname,
      createdAt: new Date().toISOString()
    };

    const db = readTricks();
    db.push(trick);
    writeTricks(db);
    res.json(trick);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rename / move category
app.patch('/api/tricks/:id', (req, res) => {
  const db = readTricks();
  const trick = db.find(t => t.id === req.params.id);
  if (!trick) return res.status(404).json({ error: '未找到' });
  if (req.body.name !== undefined) trick.name = req.body.name;
  if (req.body.category !== undefined) trick.category = req.body.category || null;
  if (req.body.notes !== undefined) trick.notes = req.body.notes;
  writeTricks(db);
  res.json(trick);
});

// ── Clip management (time-range markers, no file ops) ──
app.post('/api/tricks/:id/clips', (req, res) => {
  const db = readTricks();
  const trick = db.find(t => t.id === req.params.id);
  if (!trick) return res.status(404).json({ error: '未找到' });
  if (!trick.clips) trick.clips = [];

  const { startTime, endTime, name } = req.body;
  if (startTime === undefined || endTime === undefined)
    return res.status(400).json({ error: '缺少起止时间' });

  const clip = {
    id: randomUUID(),
    name: name?.trim() || `片段 ${trick.clips.length + 1}`,
    startTime: parseFloat(startTime),
    endTime: parseFloat(endTime)
  };
  trick.clips.push(clip);
  writeTricks(db);
  res.json(clip);
});

app.patch('/api/tricks/:trickId/clips/:clipId', (req, res) => {
  const db = readTricks();
  const trick = db.find(t => t.id === req.params.trickId);
  if (!trick?.clips) return res.status(404).json({ error: '未找到' });
  const clip = trick.clips.find(c => c.id === req.params.clipId);
  if (!clip) return res.status(404).json({ error: '片段未找到' });
  if (req.body.name !== undefined) clip.name = req.body.name;
  if (req.body.startTime !== undefined) clip.startTime = parseFloat(req.body.startTime);
  if (req.body.endTime !== undefined) clip.endTime = parseFloat(req.body.endTime);
  writeTricks(db);
  res.json(clip);
});

// ── Clip Export ──
app.get('/api/tricks/:trickId/clips/:clipId/export', async (req, res) => {
  try {
    const db = readTricks();
    const trick = db.find(t => t.id === req.params.trickId);
    if (!trick?.clips) return res.status(404).json({ error: '未找到' });
    const clip = trick.clips.find(c => c.id === req.params.clipId);
    if (!clip) return res.status(404).json({ error: '片段未找到' });

    const format = req.query.format || 'mp4';
    const inputPath = path.join(BASE, trick.videoPath);
    const dur = (clip.endTime - clip.startTime).toFixed(2);
    const safeName = clip.name.replace(/[^\w\u4e00-\u9fff-]/g, '_');

    if (format === 'gif') {
      const palettePath = path.join(UPLOADS, 'trimmed', `palette_${Date.now()}.png`);
      const outputPath = path.join(UPLOADS, 'trimmed', `${safeName}_${Date.now()}.gif`);

      // Generate palette
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-y', '-ss', String(clip.startTime), '-t', dur, '-i', inputPath,
          '-vf', 'fps=15,scale=480:-1:flags=lanczos,palettegen',
          palettePath
        ], err => err ? reject(err) : resolve());
      });

      // Generate GIF using palette
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-y', '-ss', String(clip.startTime), '-t', dur, '-i', inputPath,
          '-i', palettePath,
          '-filter_complex', '[0:v]fps=15,scale=480:-1:flags=lanczos[v];[v][1:v]paletteuse',
          outputPath
        ], (err) => {
          try { fs.unlinkSync(palettePath); } catch {}
          err ? reject(err) : resolve();
        });
      });

      res.download(outputPath, `${safeName}.gif`, err => {
        try { fs.unlinkSync(outputPath); } catch {}
      });
    } else {
      const outputPath = path.join(UPLOADS, 'trimmed', `${safeName}_${Date.now()}.mp4`);

      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-y', '-ss', String(clip.startTime), '-i', inputPath,
          '-t', dur, '-c', 'copy', '-avoid_negative_ts', 'make_zero',
          outputPath
        ], (err) => {
          if (!err) return resolve();
          // Fallback: re-encode
          execFile('ffmpeg', [
            '-y', '-ss', String(clip.startTime), '-i', inputPath,
            '-t', dur, '-c:v', 'libx264', '-c:a', 'aac',
            outputPath
          ], (err2) => err2 ? reject(err2) : resolve());
        });
      });

      res.download(outputPath, `${safeName}.mp4`, err => {
        try { fs.unlinkSync(outputPath); } catch {}
      });
    }
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

app.delete('/api/tricks/:trickId/clips/:clipId', (req, res) => {
  const db = readTricks();
  const trick = db.find(t => t.id === req.params.trickId);
  if (!trick?.clips) return res.status(404).json({ error: '未找到' });
  trick.clips = trick.clips.filter(c => c.id !== req.params.clipId);
  writeTricks(db);
  res.json({ success: true });
});

// Delete trick + files
app.delete('/api/tricks/:id', async (req, res) => {
  const db = readTricks();
  const idx = db.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '未找到' });

  const trick = db[idx];
  const videoFullPath = path.join(BASE, trick.videoPath);
  await killStreams(videoFullPath);
  await new Promise(r => setTimeout(r, 200));
  try { fs.unlinkSync(videoFullPath); } catch {}
  if (trick.thumbnail) {
    try { fs.unlinkSync(path.join(BASE, trick.thumbnail)); } catch {}
  }

  db.splice(idx, 1);
  writeTricks(db);
  res.json({ success: true });
});

// ════════════════════════════
//  Local Viewer API
// ════════════════════════════
const DATA_DIR = path.join(BASE, 'data');
const LOCAL_CLIPS_FILE = path.join(DATA_DIR, 'local-clips.json');
const LOCAL_NOTES_LEGACY = path.join(DATA_DIR, 'local-notes.json');
const APP_SETTINGS_FILE = path.join(DATA_DIR, 'app-settings.json');
const LOCAL_THUMB_DIR = path.join(UPLOADS, 'local-thumbs');
for (const d of [DATA_DIR, LOCAL_THUMB_DIR]) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function readLocalClips() { try { return JSON.parse(fs.readFileSync(LOCAL_CLIPS_FILE, 'utf-8')); } catch { return []; } }
function writeLocalClips(d) { fs.writeFileSync(LOCAL_CLIPS_FILE, JSON.stringify(d, null, 2)); }

function readAppSettings() {
  try { return { noFolderLitter: false, ...JSON.parse(fs.readFileSync(APP_SETTINGS_FILE, 'utf-8')) }; }
  catch { return { noFolderLitter: false }; }
}
function writeAppSettings(d) {
  fs.writeFileSync(APP_SETTINGS_FILE, JSON.stringify(d, null, 2));
}
function isNoFolderLitter() {
  return !!readAppSettings().noFolderLitter;
}

function readLocalNotesStore() {
  try { return JSON.parse(fs.readFileSync(LOCAL_NOTES_LEGACY, 'utf-8')); }
  catch { return {}; }
}
function writeLocalNotesStore(d) {
  fs.writeFileSync(LOCAL_NOTES_LEGACY, JSON.stringify(d, null, 2));
}
function noteTextFromStoreEntry(entry) {
  if (!entry) return '';
  return typeof entry === 'string' ? entry : (entry.text || '');
}

/** Sidecar next to media: "foo.mp4" → "foo.mp4.notes.txt" (moves with the library). */
function noteSidecarPath(filePath) {
  return filePath + '.notes.txt';
}
function mediaHasNote(filePath) {
  try {
    const p = noteSidecarPath(filePath);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
  } catch {}
  try {
    return !!noteTextFromStoreEntry(readLocalNotesStore()[filePath]).trim();
  } catch { return false; }
}
function readNoteText(filePath) {
  const side = noteSidecarPath(filePath);
  try {
    if (fs.existsSync(side)) return fs.readFileSync(side, 'utf-8');
  } catch {}
  // Fallback from data/local-notes.json (used when "禁止导出拉屎" is on)
  try {
    const text = noteTextFromStoreEntry(readLocalNotesStore()[filePath]);
    if (!text) return '';
    // Only migrate into sidecar when litter is allowed
    if (pathIsAllowed(filePath) && !isNoFolderLitter()) {
      try { fs.writeFileSync(side, text, 'utf-8'); } catch {}
    }
    return text;
  } catch { return ''; }
}
function writeNoteText(filePath, text) {
  const trimmed = String(text || '');
  const side = noteSidecarPath(filePath);
  if (isNoFolderLitter()) {
    try { if (fs.existsSync(side)) fs.unlinkSync(side); } catch {}
    const store = readLocalNotesStore();
    if (!trimmed.trim()) delete store[filePath];
    else store[filePath] = { text: trimmed, updatedAt: new Date().toISOString() };
    writeLocalNotesStore(store);
    return null;
  }
  if (!trimmed.trim()) {
    try { if (fs.existsSync(side)) fs.unlinkSync(side); } catch {}
    try {
      const store = readLocalNotesStore();
      if (store[filePath] != null) {
        delete store[filePath];
        writeLocalNotesStore(store);
      }
    } catch {}
    return null;
  }
  fs.writeFileSync(side, trimmed, 'utf-8');
  return side;
}
function remapLocalNotesPath(oldPath, newPath) {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const from = noteSidecarPath(oldPath);
  const to = noteSidecarPath(newPath);
  try {
    if (fs.existsSync(from)) {
      try { if (fs.existsSync(to)) fs.unlinkSync(to); } catch {}
      fs.renameSync(from, to);
    }
  } catch (e) {
    console.warn('[notes] remap failed:', e.message);
  }
  try {
    const store = readLocalNotesStore();
    if (store[oldPath] != null) {
      store[newPath] = store[oldPath];
      delete store[oldPath];
      writeLocalNotesStore(store);
    }
  } catch (e) {
    console.warn('[notes] store remap failed:', e.message);
  }
}
function deleteLocalNote(filePath) {
  try {
    const side = noteSidecarPath(filePath);
    if (fs.existsSync(side)) fs.unlinkSync(side);
  } catch {}
  try {
    const store = readLocalNotesStore();
    if (store[filePath] != null) {
      delete store[filePath];
      writeLocalNotesStore(store);
    }
  } catch {}
}

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.m4v']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.svg', '.gif', '.avif', '.tiff', '.ico']);
const SUBTITLE_EXTS = new Set(['.srt', '.ass', '.ssa', '.vtt']);

// ── Whitelist API ──
app.get('/api/local/whitelist', (_req, res) => {
  res.json(readWhitelist());
});

app.get('/api/local/directory', (req, res) => {
  const dirPath = req.query.path;
  if (!dirPath) return res.status(400).json({ error: '请输入路径' });
  if (!pathIsAllowed(dirPath)) return res.status(403).json({ error: '该路径不在白名单中' });
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return res.status(400).json({ error: '路径不存在' });
    }

    function scan(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const videos = [];
      const folders = [];
      const subtitleFiles = [];
      for (const e of entries) {
        if (e.name === '.TThumb.PNG') continue;
        const ext = path.extname(e.name).toLowerCase();
        if (e.isFile() && (VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext))) {
          const fp = path.join(dir, e.name);
          let size = 0, birthtime = 0;
          try { const st = fs.statSync(fp); size = st.size; birthtime = st.birthtimeMs || st.mtimeMs; } catch {}
          if (e.name.endsWith('.notes.txt')) continue;
          const mHash = require('crypto').createHash('md5').update(fp).digest('hex');
          const hasManualCover = fs.existsSync(path.join(LOCAL_THUMB_DIR, mHash + '.manual.jpg'));
          videos.push({ name: e.name, path: fp, size, birthtime, hasManualCover, hasNote: mediaHasNote(fp), type: IMAGE_EXTS.has(ext) ? 'image' : 'video' });
        } else if (e.isFile() && SUBTITLE_EXTS.has(ext)) {
          subtitleFiles.push(e.name);
        } else if (e.isDirectory()) {
          folders.push(scan(path.join(dir, e.name)));
        }
      }
      // Match subtitle files to videos by base name
      for (const v of videos) {
        const base = path.basename(v.name, path.extname(v.name));
        const subs = subtitleFiles.filter(s => path.basename(s, path.extname(s)) === base);
        if (subs.length) {
          v.subtitles = subs.map(s => ({ name: s, path: path.join(dir, s) }));
        }
      }
      videos.sort((a, b) => a.name.localeCompare(b.name));
      folders.sort((a, b) => a.name.localeCompare(b.name));
      const hasThumb = fs.existsSync(path.join(dir, '.TThumb.PNG'));
      return { name: path.basename(dir), path: dir, videos, folders, hasThumb };
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(scan(dirPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight folder scan (direct contents only, no recursion) — for refresh
app.get('/api/local/scan-folder', (req, res) => {
  const dirPath = req.query.path;
  if (!dirPath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(dirPath)) return res.status(403).json({ error: '该路径不在白名单中' });
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return res.status(400).json({ error: '路径不存在' });
    }
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const videos = [];
    const folders = [];
    const subtitleFiles = [];
    for (const e of entries) {
      if (e.name === '.TThumb.PNG') continue;
      const ext = path.extname(e.name).toLowerCase();
      if (e.name.endsWith('.notes.txt')) continue;
      if (e.isFile() && (VIDEO_EXTS.has(ext) || IMAGE_EXTS.has(ext))) {
        const fp = path.join(dirPath, e.name);
        let size = 0, birthtime = 0;
        try { const st = fs.statSync(fp); size = st.size; birthtime = st.birthtimeMs || st.mtimeMs; } catch {}
        const mHash = require('crypto').createHash('md5').update(fp).digest('hex');
        const hasManualCover = fs.existsSync(path.join(LOCAL_THUMB_DIR, mHash + '.manual.jpg'));
        videos.push({ name: e.name, path: fp, size, birthtime, hasManualCover, hasNote: mediaHasNote(fp), type: IMAGE_EXTS.has(ext) ? 'image' : 'video' });
      } else if (e.isFile() && SUBTITLE_EXTS.has(ext)) {
        subtitleFiles.push(e.name);
      } else if (e.isDirectory()) {
        const subPath = path.join(dirPath, e.name);
        const hasThumb = fs.existsSync(path.join(subPath, '.TThumb.PNG'));
        folders.push({ name: e.name, path: subPath, videos: [], folders: [], hasThumb });
      }
    }
    // Match subtitle files to videos by base name
    for (const v of videos) {
      const base = path.basename(v.name, path.extname(v.name));
      const subs = subtitleFiles.filter(s => path.basename(s, path.extname(s)) === base);
      if (subs.length) {
        v.subtitles = subs.map(s => ({ name: s, path: path.join(dirPath, s) }));
      }
    }
    videos.sort((a, b) => a.name.localeCompare(b.name));
    folders.sort((a, b) => a.name.localeCompare(b.name));
    const hasThumb = fs.existsSync(path.join(dirPath, '.TThumb.PNG'));
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ name: path.basename(dirPath), path: dirPath, videos, folders, hasThumb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track open file streams so we can destroy them before deletion
const openStreams = new Map(); // resolvedPath -> Set of {stream, res}

function streamKey(filePath) {
  try { return path.resolve(filePath); } catch { return filePath; }
}

function pathsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = streamKey(a);
  const nb = streamKey(b);
  if (na === nb) return true;
  if (process.platform === 'win32') return na.toLowerCase() === nb.toLowerCase();
  return false;
}

function trackOpenStream(filePath, stream, res) {
  const key = streamKey(filePath);
  if (!openStreams.has(key)) openStreams.set(key, new Set());
  const entry = { stream, res };
  openStreams.get(key).add(entry);
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    const s = openStreams.get(key);
    if (s) { s.delete(entry); if (s.size === 0) openStreams.delete(key); }
  };
  stream.on('end', cleanup);
  stream.on('close', cleanup);
  stream.on('error', cleanup);
  res.on('close', cleanup);
  return entry;
}

function killStreams(filePath) {
  return new Promise(resolve => {
    const entries = [];
    const keysToDelete = [];
    for (const [k, set] of openStreams) {
      if (pathsMatch(k, filePath)) {
        for (const e of set) entries.push(e);
        keysToDelete.push(k);
      }
    }
    for (const k of keysToDelete) openStreams.delete(k);
    if (!entries.length) return resolve();

    console.log('[killStreams]', filePath, '→', entries.length, 'stream(s)');
    let remaining = entries.length;
    const timer = setTimeout(() => {
      console.log('[killStreams] timeout,', remaining, 'still open');
      resolve();
    }, 2000);
    const onDone = () => {
      remaining--;
      if (remaining <= 0) { clearTimeout(timer); resolve(); }
    };
    for (const s of entries) {
      try { s.stream.unpipe(); } catch {}
      s.stream.once('close', onDone);
      s.stream.once('end', onDone);
      s.stream.once('error', onDone);
      try { s.stream.destroy(); } catch { onDone(); }
      try { if (s.res && !s.res.writableEnded) s.res.end(); } catch {}
      try { if (s.res && typeof s.res.destroy === 'function') s.res.destroy(); } catch {}
    }
  });
}

app.get('/api/local/stream', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('No path');
  if (!pathIsAllowed(filePath)) return res.status(403).send('Forbidden');
  try {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const videoMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.wmv': 'video/x-msvideo', '.m4v': 'video/mp4' };
    const imageMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.tiff': 'image/tiff', '.ico': 'image/x-icon' };
    const isVideo = videoMap[ext];
    const isImage = imageMap[ext];
    const contentType = isVideo || isImage || 'application/octet-stream';
    const asDownload = req.query.download === '1' || req.query.download === 'true';
    const disposition = asDownload
      ? `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`
      : null;

    // Images: read entire file into memory — no persistent file handle
    if (isImage) {
      const maxImageSize = 50 * 1024 * 1024; // 50MB limit for in-memory
      if (stat.size <= maxImageSize) {
        const data = fs.readFileSync(filePath);
        const headers = { 'Content-Length': stat.size, 'Content-Type': isImage, 'Cache-Control': 'max-age=3600' };
        if (disposition) headers['Content-Disposition'] = disposition;
        res.writeHead(200, headers);
        return res.end(data);
      }
      // Fall through to streaming for very large images
    }

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const safeEnd = Math.min(end, stat.size - 1);
      if (start > safeEnd || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      const rangeHeaders = {
        'Content-Range': `bytes ${start}-${safeEnd}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': safeEnd - start + 1,
        'Content-Type': contentType
      };
      if (disposition) rangeHeaders['Content-Disposition'] = disposition;
      res.writeHead(206, rangeHeaders);
      const stream = fs.createReadStream(filePath, { start, end: safeEnd });
      stream.on('error', (err) => {
        console.error('Stream read error:', err.message);
        if (!res.headersSent) res.status(500).send('Stream error');
        else res.end();
      });
      trackOpenStream(filePath, stream, res);
      stream.pipe(res);
    } else {
      const fullHeaders = { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };
      if (disposition) fullHeaders['Content-Disposition'] = disposition;
      res.writeHead(200, fullHeaders);
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        console.error('Stream read error:', err.message);
        if (!res.headersSent) res.status(500).send('Stream error');
        else res.end();
      });
      trackOpenStream(filePath, stream, res);
      stream.pipe(res);
    }
  } catch (err) {
    console.error('Stream 404:', filePath, '-', err.message);
    if (!res.headersSent)   res.status(404).send('File not found');
  }
});

// ── Browser-playable remux cache (MKV/AVI/… → seekable MP4 on disk) ──
const REMUX_EXTS = new Set(['.mkv', '.avi', '.wmv', '.flv', '.ts', '.m2ts']);
const PLAY_CACHE_DIR = path.join(UPLOADS, 'play-cache');
if (!fs.existsSync(PLAY_CACHE_DIR)) fs.mkdirSync(PLAY_CACHE_DIR, { recursive: true });
const _playCacheJobs = new Map(); // hash -> Promise<string outPath>

function playCacheKey(filePath) {
  const st = fs.statSync(filePath);
  return require('crypto').createHash('md5')
    .update(filePath + '@' + st.size + '@' + Math.floor(st.mtimeMs))
    .digest('hex');
}

function runFfmpegArgs(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => {
      err += d.toString();
      if (err.length > 4000) err = err.slice(-3000);
    });
    ff.on('error', reject);
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error((err || 'ffmpeg failed').slice(-500)));
    });
  });
}

async function ensurePlayCache(filePath) {
  const hash = playCacheKey(filePath);
  const outPath = path.join(PLAY_CACHE_DIR, hash + '.mp4');
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) return outPath;
  if (_playCacheJobs.has(hash)) return _playCacheJobs.get(hash);

  const job = (async () => {
    const tmp = outPath + '.tmp.' + process.pid;
    try { fs.unlinkSync(tmp); } catch {}
    const common = ['-y', '-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
    try {
      // Fast path: stream copy into seekable MP4 (works for H.264/AAC etc.)
      await runFfmpegArgs([...common, '-c', 'copy', '-movflags', '+faststart', tmp]);
    } catch (e1) {
      console.warn('[play-cache] copy failed, retry with aac:', e1.message);
      try { fs.unlinkSync(tmp); } catch {}
      // Keep video copy, re-encode audio to AAC for MP4 compatibility
      await runFfmpegArgs([...common, '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', tmp]);
    }
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) {
      try { fs.unlinkSync(tmp); } catch {}
      throw new Error('remux produced empty file');
    }
    try { fs.unlinkSync(outPath); } catch {}
    fs.renameSync(tmp, outPath);
    console.log('[play-cache] ready:', path.basename(filePath), '->', hash + '.mp4');
    return outPath;
  })();

  _playCacheJobs.set(hash, job);
  try {
    return await job;
  } finally {
    _playCacheJobs.delete(hash);
  }
}

function sendMp4WithRange(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const contentType = 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const safeEnd = Math.min(end, stat.size - 1);
    if (start > safeEnd || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${safeEnd}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': safeEnd - start + 1,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400'
    });
    const stream = fs.createReadStream(filePath, { start, end: safeEnd });
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
    trackOpenStream(filePath, stream, res);
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400'
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
    trackOpenStream(filePath, stream, res);
    stream.pipe(res);
  }
}

app.get('/api/local/play-ready', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'No path' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ ready: false, remux: false });
  const ext = path.extname(filePath).toLowerCase();
  if (!REMUX_EXTS.has(ext)) return res.json({ ready: true, remux: false });
  try {
    const hash = playCacheKey(filePath);
    const outPath = path.join(PLAY_CACHE_DIR, hash + '.mp4');
    const ready = fs.existsSync(outPath) && fs.statSync(outPath).size > 1000;
    const preparing = _playCacheJobs.has(hash);
    res.json({ ready, remux: true, preparing });
  } catch {
    res.json({ ready: false, remux: true });
  }
});

app.get('/api/local/play', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('No path');
  if (!pathIsAllowed(filePath)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  const ext = path.extname(filePath).toLowerCase();
  if (!REMUX_EXTS.has(ext)) {
    return res.redirect(302, '/api/local/stream?path=' + encodeURIComponent(filePath));
  }

  try {
    const cached = await ensurePlayCache(filePath);
    sendMp4WithRange(cached, req, res);
  } catch (err) {
    console.error('[play] remux failed:', filePath, err.message);
    if (!res.headersSent) res.status(500).send('Remux failed: ' + err.message);
  }
});

// ── Open file in local player (MPV / VLC / IINA) on the machine running this server ──
function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function resolvePlayerLaunch(player, filePath) {
  const p = (player || 'mpv').toLowerCase();
  if (p === 'mpv') {
    const bin = process.env.MPV_PATH || firstExisting([
      process.platform === 'win32' && 'C:\\Program Files\\mpv\\mpv.exe',
      process.platform === 'win32' && 'C:\\Program Files (x86)\\mpv\\mpv.exe',
      process.platform === 'win32' && path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
      process.platform === 'win32' && path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
      process.platform === 'darwin' && '/Applications/mpv.app/Contents/MacOS/mpv',
      process.platform === 'darwin' && '/opt/homebrew/bin/mpv',
      process.platform === 'darwin' && '/usr/local/bin/mpv'
    ]) || 'mpv';
    return { bin, args: ['--force-window=immediate', '--', filePath], label: 'MPV' };
  }
  if (p === 'vlc') {
    const bin = process.env.VLC_PATH || firstExisting([
      process.platform === 'win32' && 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      process.platform === 'win32' && 'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
      process.platform === 'darwin' && '/Applications/VLC.app/Contents/MacOS/VLC',
      process.platform === 'linux' && '/usr/bin/vlc'
    ]) || 'vlc';
    return { bin, args: ['--', filePath], label: 'VLC' };
  }
  if (p === 'iina') {
    if (process.platform === 'darwin') {
      const cli = firstExisting([
        '/Applications/IINA.app/Contents/MacOS/iina-cli',
        '/opt/homebrew/bin/iina-cli',
        '/usr/local/bin/iina-cli'
      ]);
      if (cli) return { bin: cli, args: [filePath], label: 'IINA' };
      return { bin: 'open', args: ['-a', 'IINA', filePath], label: 'IINA' };
    }
    return null;
  }
  if (p === 'potplayer' || p === 'pot') {
    const bin = process.env.POTPLAYER_PATH || firstExisting([
      process.platform === 'win32' && 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
      process.platform === 'win32' && 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini.exe',
      process.platform === 'win32' && 'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
      process.platform === 'win32' && 'C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe',
      process.platform === 'win32' && 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayer64.exe',
      process.platform === 'win32' && 'C:\\Program Files\\DAUM\\PotPlayer\\PotPlayer.exe'
    ]);
    if (!bin) {
      if (process.platform !== 'win32') return null;
      return { bin: 'PotPlayerMini64.exe', args: [filePath], label: 'PotPlayer' };
    }
    return { bin, args: [filePath], label: 'PotPlayer' };
  }
  return null;
}

function handleOpenPlayer(req, res) {
  const filePath = req.body?.path || req.query.path;
  const player = (req.body?.player || req.query.player || 'mpv').toLowerCase();
  if (!filePath) return res.status(400).json({ error: 'No path' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const launch = resolvePlayerLaunch(player, filePath);
  if (!launch) {
    const err =
      player === 'iina' ? 'IINA 仅支持 macOS'
      : (player === 'potplayer' || player === 'pot') ? 'PotPlayer 仅支持 Windows'
      : '未知播放器';
    return res.status(400).json({ error: err });
  }

  let responded = false;
  const done = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  try {
    const child = spawn(launch.bin, launch.args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false
    });
    child.on('error', (err) => {
      console.error('[open-player]', player, 'spawn error:', err.message);
      done(500, { error: `无法启动 ${launch.label}，请确认已安装（或设置 ${player.toUpperCase()}_PATH）` });
    });
    child.unref();
    setTimeout(() => done(200, { ok: true, player }), 250);
  } catch (err) {
    done(500, { error: err.message || '播放器启动失败' });
  }
}

app.post('/api/local/open-player', handleOpenPlayer);
app.post('/api/local/open-mpv', (req, res) => {
  if (!req.body) req.body = {};
  req.body.player = 'mpv';
  handleOpenPlayer(req, res);
});

// ── Release all open file handles (for safe folder deletion) ──
app.post('/api/local/release', (req, res) => {
  let killed = 0;
  // Kill all tracked streams
  for (const [filePath, set] of openStreams) {
    for (const s of set) {
      try { s.stream.destroy(); } catch {}
      try { s.res.end(); } catch {}
      killed++;
    }
  }
  openStreams.clear();
  // Also let any pending thumbnail queue drain (they don't hold open files long)
  // The point is to release file handles held by video streaming
  res.json({ released: killed, message: killed > 0 ? `已释放 ${killed} 个文件句柄` : '没有需要释放的文件句柄' });
});

// ── Restart the Node.js process to truly release all file handles ──
app.post('/api/restart', (req, res) => {
  let killed = 0;
  for (const [filePath, set] of openStreams) {
    for (const s of set) {
      try { s.stream.destroy(); } catch {}
      try { s.res.end(); } catch {}
      killed++;
    }
  }
  openStreams.clear();
  res.json({ success: true, released: killed, message: '服务器正在重启以释放占用...' });
  try {
    const child = spawn(process.argv[0], process.argv.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, RESTART_DELAY: '1500' },
      stdio: 'inherit'
    });
    child.on('error', (err) => console.error('[restart] spawn error:', err));
  } catch (e) {
    console.error('[restart] failed to spawn:', e);
  }
  setTimeout(() => process.exit(0), 300);
});

// ── Subtitle file ──
app.get('/api/local/subtitle', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: '该路径不在白名单中' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  const ext = path.extname(filePath).toLowerCase();
  const ct = ext === '.vtt' ? 'text/vtt' : ext === '.ass' || ext === '.ssa' ? 'text/x-ssa' : 'text/plain';
  res.setHeader('Content-Type', ct + '; charset=utf-8');
  fs.createReadStream(filePath).pipe(res);
});


// ── Thumbnail generation concurrency limiter ──
const THUMB_CONCURRENCY = 3;
let thumbRunning = 0;
const thumbQueue = [];

function acquireThumbSlot() {
  return new Promise(resolve => {
    if (thumbRunning < THUMB_CONCURRENCY) {
      thumbRunning++;
      resolve();
    } else {
      thumbQueue.push(resolve);
    }
  });
}

function releaseThumbSlot() {
  thumbRunning--;
  if (thumbQueue.length > 0 && thumbRunning < THUMB_CONCURRENCY) {
    thumbRunning++;
    const next = thumbQueue.shift();
    next();
  }
}

app.get('/api/local/thumbnail', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('No path');
  if (!pathIsAllowed(filePath)) return res.status(403).send('Forbidden');
  const customTime = req.query.t; // optional custom timestamp in seconds
  try {
    // Manual cover: hash based on path only (no time), always takes priority
    const manualHash = require('crypto').createHash('md5').update(filePath).digest('hex');
    const manualPath = path.join(LOCAL_THUMB_DIR, manualHash + '.manual.jpg');
    const hasManual = fs.existsSync(manualPath) && fs.statSync(manualPath).size > 500;
    console.log('[thumb] path:', filePath, 't:', customTime, 'manual:', hasManual);
    if (hasManual) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.sendFile(manualPath);
    }

    // Images: serve original directly — no ffmpeg needed
    const fileExt = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTS.has(fileExt)) {
      if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
      res.set('Cache-Control', req.query._ ? 'no-store, no-cache, must-revalidate' : 'public, max-age=86400');
      return res.sendFile(path.resolve(filePath));
    }

    // Auto-generated thumbnail: hash includes time
    const hashInput = customTime ? filePath + '@' + customTime : filePath;
    const hash = require('crypto').createHash('md5').update(hashInput).digest('hex');
    const thumbPath = path.join(LOCAL_THUMB_DIR, hash + '.jpg');

    if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size < 500) {
      // Acquire concurrency slot before running ffmpeg
      await acquireThumbSlot();
      try {
        // Re-check after waiting for slot — another request may have generated it
        if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size >= 500) {
          // Already generated by another request, skip ffmpeg
        } else {
          // Check if file exists before running ffmpeg
          if (!fs.existsSync(filePath)) {
            console.error('[thumb] File not found:', filePath);
            releaseThumbSlot();
            return res.status(404).send('File not found');
          }
          try { fs.unlinkSync(thumbPath); } catch {}
          let ok = false;

          // Probe video duration first to avoid seeking past end
          let duration = 0;
          try {
            const probeResult = await new Promise((resolve, reject) => {
              execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
                { timeout: 5000 },
                (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
            });
            duration = parseFloat(probeResult) || 0;
          } catch { /* duration unknown, proceed with caution */ }

          // Clamp customTime to video duration
          let seekTime = customTime != null ? Number(customTime) : null;
          if (seekTime != null && duration > 0 && seekTime >= duration) {
            seekTime = Math.max(0, duration - 1); // 1 second before end
          }

          if (seekTime != null) {
            // Use only the specified timestamp (clamped)
            try {
              await new Promise((resolve, reject) => {
                execFile('ffmpeg', ['-y', '-ss', String(seekTime), '-i', filePath, '-vframes', '1', '-vf', 'scale=480:-1', thumbPath],
                  { timeout: 10000 },
                  err => err ? reject(err) : resolve());
              });
              if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 500) ok = true;
            } catch {}
            // Fallback: if custom time failed, try earlier timestamps
            if (!ok) {
              for (const t of ['0', '0.5']) {
                try {
                  await new Promise((resolve, reject) => {
                    execFile('ffmpeg', ['-y', '-ss', t, '-i', filePath, '-vframes', '1', '-vf', 'scale=480:-1', thumbPath],
                      { timeout: 10000 },
                      err => err ? reject(err) : resolve());
                  });
                  if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 500) { ok = true; break; }
                } catch {}
              }
            }
          } else {
            // Try multiple timestamps
            for (const t of ['1', '0.5', '0']) {
              try {
                await new Promise((resolve, reject) => {
                  execFile('ffmpeg', ['-y', '-ss', t, '-i', filePath, '-vframes', '1', '-vf', 'scale=480:-1', thumbPath],
                    { timeout: 10000 },
                    err => err ? reject(err) : resolve());
                });
                if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 500) { ok = true; break; }
              } catch {}
            }
          }
          if (!ok) {
            releaseThumbSlot();
            return res.status(404).send('Thumbnail failed');
          }
        }
      } finally {
        releaseThumbSlot();
      }
    }
    // Auto thumbnail: long cache (frontend only cache-busts manual covers)
    if (req.query._) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      res.set('Cache-Control', 'public, max-age=86400');
    }
    res.sendFile(thumbPath);
  } catch {
    res.status(404).send('Thumbnail failed');
  }
});

app.get('/api/local/clips-counts', (req, res) => {
  const db = readLocalClips();
  const counts = {};
  for (const c of db) counts[c.videoPath] = (counts[c.videoPath] || 0) + 1;
  res.json(counts);
});

app.get('/api/local/clips', (req, res) => {
  const videoPath = req.query.path;
  const clips = readLocalClips().filter(c => c.videoPath === videoPath);
  res.json(clips);
});

app.post('/api/local/clips', (req, res) => {
  const { videoPath, name, startTime, endTime } = req.body;
  if (!videoPath || startTime == null || endTime == null) return res.status(400).json({ error: '参数不完整' });
  const clip = {
    id: randomUUID(), videoPath,
    name: name?.trim() || '片段',
    startTime: parseFloat(startTime), endTime: parseFloat(endTime),
    createdAt: new Date().toISOString()
  };
  const db = readLocalClips(); db.push(clip); writeLocalClips(db);
  res.json(clip);
});

app.patch('/api/local/clips/:id', (req, res) => {
  const db = readLocalClips();
  const clip = db.find(c => c.id === req.params.id);
  if (!clip) return res.status(404).json({ error: '未找到' });
  if (req.body.name !== undefined) clip.name = req.body.name;
  if (req.body.startTime !== undefined) clip.startTime = parseFloat(req.body.startTime);
  if (req.body.endTime !== undefined) clip.endTime = parseFloat(req.body.endTime);
  writeLocalClips(db); res.json(clip);
});

app.delete('/api/local/clips/:id', (req, res) => {
  let db = readLocalClips();
  db = db.filter(c => c.id !== req.params.id);
  writeLocalClips(db); res.json({ success: true });
});

// ── Per-video notes (sidecar "video.mp4.notes.txt" next to the file) ──
app.get('/api/local/notes-flags', (req, res) => {
  // Optional ?paths= encoded JSON array of media paths to check
  let paths = [];
  try {
    if (req.query.paths) paths = JSON.parse(req.query.paths);
  } catch {}
  if (!Array.isArray(paths) || !paths.length) return res.json({});
  const flags = {};
  for (const p of paths) {
    if (typeof p === 'string' && pathIsAllowed(p) && mediaHasNote(p)) flags[p] = true;
  }
  res.json(flags);
});

app.get('/api/local/notes', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: '该路径不在白名单中' });
  const text = readNoteText(filePath);
  let updatedAt = null;
  const noLitter = isNoFolderLitter();
  try {
    const side = noteSidecarPath(filePath);
    if (fs.existsSync(side)) updatedAt = fs.statSync(side).mtime.toISOString();
  } catch {}
  if (!updatedAt) {
    try {
      const entry = readLocalNotesStore()[filePath];
      if (entry && typeof entry === 'object' && entry.updatedAt) updatedAt = entry.updatedAt;
    } catch {}
  }
  res.json({
    path: filePath, text, updatedAt,
    sidecar: noLitter ? null : noteSidecarPath(filePath),
    storage: noLitter ? 'data' : 'sidecar'
  });
});

app.put('/api/local/notes', (req, res) => {
  const filePath = req.body?.path;
  const text = req.body?.text != null ? String(req.body.text) : '';
  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: '该路径不在白名单中' });
  try {
    writeNoteText(filePath, text);
    const trimmed = text.trim();
    const noLitter = isNoFolderLitter();
    let updatedAt = null;
    if (trimmed) {
      if (noLitter) {
        try {
          const entry = readLocalNotesStore()[filePath];
          updatedAt = (entry && entry.updatedAt) || new Date().toISOString();
        } catch { updatedAt = new Date().toISOString(); }
      } else {
        try { updatedAt = fs.statSync(noteSidecarPath(filePath)).mtime.toISOString(); } catch {}
      }
    }
    res.json({
      success: true, path: filePath, text: trimmed ? text : '', updatedAt,
      sidecar: noLitter ? null : noteSidecarPath(filePath),
      storage: noLitter ? 'data' : 'sidecar'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/local/clips/:id/export', async (req, res) => {
  try {
    const db = readLocalClips();
    const clip = db.find(c => c.id === req.params.id);
    if (!clip) return res.status(404).json({ error: '片段未找到' });

    const inputPath = clip.videoPath;
    if (!fs.existsSync(inputPath)) return res.status(404).json({ error: '视频文件不存在' });

    const dur = (clip.endTime - clip.startTime).toFixed(2);
    const safeName = clip.name.replace(/[^\w\u4e00-\u9fff-]/g, '_');
    const outputPath = path.join(UPLOADS, 'trimmed', `${safeName}_${Date.now()}.mp4`);

    // Try stream copy first (fast), fallback to re-encode
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y', '-ss', String(clip.startTime), '-i', inputPath,
        '-t', dur, '-c', 'copy', '-avoid_negative_ts', 'make_zero',
        outputPath
      ], (err) => {
        if (!err) return resolve();
        execFile('ffmpeg', [
          '-y', '-ss', String(clip.startTime), '-i', inputPath,
          '-t', dur, '-c:v', 'libx264', '-c:a', 'aac',
          outputPath
        ], (err2) => err2 ? reject(err2) : resolve());
      });
    });

    res.download(outputPath, `${safeName}.mp4`, () => {
      try { fs.unlinkSync(outputPath); } catch {}
    });
  } catch (err) {
    console.error('Local clip export error:', err);
    res.status(500).json({ error: '导出失败: ' + err.message });
  }
});

// ── App settings (e.g. noFolderLitter) ──
app.get('/api/app-settings', (req, res) => {
  res.json(readAppSettings());
});
app.put('/api/app-settings', (req, res) => {
  try {
    const cur = readAppSettings();
    if (typeof req.body?.noFolderLitter === 'boolean') cur.noFolderLitter = req.body.noFolderLitter;
    writeAppSettings(cur);
    res.json(cur);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Folder thumbnail ──
const thumbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/local/folder-thumb', thumbUpload.single('thumb'), (req, res) => {
  try {
    if (isNoFolderLitter()) {
      return res.status(403).json({
        error: '已开启「禁止导出拉屎」：不会在文件夹内生成 .TThumb.PNG 封面文件'
      });
    }
    const folderPath = req.body.folderPath;
    if (!folderPath || !req.file) return res.status(400).json({ error: '缺少参数' });
    const thumbPath = path.join(folderPath, '.TThumb.PNG');
    fs.writeFileSync(thumbPath, req.file.buffer);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/local/folder-thumb', (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) return res.status(400).send('No path');
  const thumbPath = path.join(folderPath, '.TThumb.PNG');
  if (!fs.existsSync(thumbPath)) return res.status(404).send('Not found');
  const ext = path.extname(thumbPath).toLowerCase();
  const ct = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  fs.createReadStream(thumbPath).pipe(res);
});

app.delete('/api/local/folder-thumb', (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) return res.status(400).json({ error: '缺少路径' });
  const thumbPath = path.join(folderPath, '.TThumb.PNG');
  try {
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Thumb time per folder ──
function readThumbTimes() {
  try { return JSON.parse(fs.readFileSync(THUMB_TIMES_FILE, 'utf-8')); }
  catch { return {}; }
}
function writeThumbTimes(d) { fs.writeFileSync(THUMB_TIMES_FILE, JSON.stringify(d, null, 2)); }

app.get('/api/local/thumb-time', (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) return res.status(400).json({ error: '缺少路径' });
  const times = readThumbTimes();
  res.json({ time: times[folderPath] ?? 1 });
});

app.post('/api/local/thumb-time', (req, res) => {
  const { path: folderPath, time } = req.body;
  if (!folderPath || time == null) return res.status(400).json({ error: '参数不完整' });
  const times = readThumbTimes();
  times[folderPath] = Number(time);
  writeThumbTimes(times);
  res.json({ success: true });
});

// ── Resource Links ──
function readResourceLinks() {
  try { return JSON.parse(fs.readFileSync(RESOURCE_LINKS_FILE, 'utf-8')); }
  catch { return []; }
}
function writeResourceLinks(d) { fs.writeFileSync(RESOURCE_LINKS_FILE, JSON.stringify(d, null, 2)); }

app.get('/api/resource-links', (_req, res) => {
  res.json(readResourceLinks());
});

app.post('/api/resource-links', (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: '无效数据' });
  writeResourceLinks(data);
  res.json({ success: true });
});

// ════════════════════════════
//  Play History API
// ════════════════════════════
const PLAY_HISTORY_FILE = path.join(BASE, 'data', 'play-history.json');
const HISTORY_EXCLUDE_FILE = path.join(BASE, 'data', 'history-exclude.json');

function readPlayHistory() {
  try { return JSON.parse(fs.readFileSync(PLAY_HISTORY_FILE, 'utf-8')); }
  catch { return []; }
}
function writePlayHistory(d) { fs.writeFileSync(PLAY_HISTORY_FILE, JSON.stringify(d, null, 2)); }

function readHistoryExclude() {
  try { return JSON.parse(fs.readFileSync(HISTORY_EXCLUDE_FILE, 'utf-8')); }
  catch { return []; }
}
function writeHistoryExclude(d) { fs.writeFileSync(HISTORY_EXCLUDE_FILE, JSON.stringify(d, null, 2)); }

function isHistoryExcluded(filePath) {
  const excludes = readHistoryExclude();
  if (!Array.isArray(excludes) || !excludes.length) return false;
  const norm = filePath.replace(/\\/g, '/');
  return excludes.some(ex => {
    const e = String(ex).replace(/\\/g, '/').replace(/\/+$/, '');
    return norm === e || norm.startsWith(e + '/');
  });
}

app.get('/api/play-history', (_req, res) => {
  res.json(readPlayHistory());
});

app.post('/api/play-history', (req, res) => {
  const { trickId, trickName, progress } = req.body;
  if (!trickId) return res.status(400).json({ error: '缺少 trickId' });
  if (isHistoryExcluded(trickId)) return res.json({ success: true, excluded: true });
  let history = readPlayHistory();
  const existing = history.find(h => h.trickId === trickId);
  if (existing) {
    existing.lastPlayedAt = new Date().toISOString();
    if (progress !== undefined) existing.progress = progress;
    if (trickName !== undefined) existing.trickName = trickName;
  } else {
    history.push({
      trickId,
      trickName: trickName || '',
      progress: progress || 0,
      lastPlayedAt: new Date().toISOString()
    });
  }
  // Keep only the latest 200 entries, sort by lastPlayedAt desc
  history.sort((a, b) => new Date(b.lastPlayedAt) - new Date(a.lastPlayedAt));
  if (history.length > 200) history = history.slice(0, 200);
  writePlayHistory(history);
  res.json({ success: true });
});

app.delete('/api/play-history', (_req, res) => {
  writePlayHistory([]);
  res.json({ success: true });
});

// Delete all play-history entries inside a given folder
app.delete('/api/play-history/folder', (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) return res.status(400).json({ error: '缺少路径' });
  const norm = String(folderPath).replace(/\\/g, '/').replace(/\/+$/, '');
  function dirOf(p) {
    const n = String(p).replace(/\\/g, '/');
    const idx = n.lastIndexOf('/');
    return idx > 0 ? n.slice(0, idx) : '';
  }
  let history = readPlayHistory();
  const before = history.length;
  history = history.filter(h => dirOf(h.trickId) !== norm);
  writePlayHistory(history);
  res.json({ success: true, removed: before - history.length });
});

// ════════════════════════════
//  Play History Exclude API
// ════════════════════════════
app.get('/api/history-exclude', (_req, res) => {
  res.json(readHistoryExclude());
});

app.post('/api/history-exclude', (req, res) => {
  const { action, path: folderPath } = req.body || {};
  if (!folderPath || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: '参数不完整' });
  }
  if (!pathIsAllowed(folderPath)) {
    return res.status(403).json({ error: '该路径不在白名单中' });
  }
  let excludes = readHistoryExclude();
  if (!Array.isArray(excludes)) excludes = [];
  const norm = path.resolve(folderPath);
  if (action === 'add') {
    if (!excludes.includes(norm)) excludes.push(norm);
  } else if (action === 'remove') {
    excludes = excludes.filter(p => p !== norm);
  }
  writeHistoryExclude(excludes);
  res.json({ success: true, excludes });
});

app.post('/api/local/release-file', async (req, res) => {
  const filePath = req.body?.path || req.query.path;
  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  await killStreams(filePath);
  res.json({ ok: true });
});

app.delete('/api/local/file', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: '该路径不在白名单中' });
  try {
    console.log('[delete] attempt:', filePath);
    if (!fs.existsSync(filePath)) {
      console.log('[delete] file not found:', filePath);
      return res.status(404).json({ error: '文件不存在' });
    }
    // Kill any open streams for this file and wait for FDs to close
    await killStreams(filePath);
    await new Promise(r => setTimeout(r, 150));
    // Second pass in case browser re-requested during the first kill
    await killStreams(filePath);
    await new Promise(r => setTimeout(r, 100));

    const delays = [0, 200, 500, 1000];
    let lastErr = null;
    for (const d of delays) {
      if (d) await new Promise(r => setTimeout(r, d));
      await killStreams(filePath);
      try {
        fs.unlinkSync(filePath);
        if (!fs.existsSync(filePath)) {
          console.log('[delete] OK:', filePath);
          deleteLocalNote(filePath);
          return res.json({ success: true });
        }
      } catch (e) {
        lastErr = e;
        console.log('[delete] unlink retry:', e.message);
      }
    }

    if (fs.existsSync(filePath)) {
      console.log('[delete] STILL EXISTS after retries:', filePath, lastErr?.message || '');
      const tempDir = path.join(os.tmpdir(), 'videos-tricks-deleted');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, `${Date.now()}_${path.basename(filePath)}`);
      try {
        await killStreams(filePath);
        fs.renameSync(filePath, tempPath);
        console.log('[delete] moved to temp:', tempPath);
        deleteLocalNote(filePath);
        return res.json({ success: true, moved: true });
      } catch (e) {
        console.log('[delete] move failed:', e.message);
      }
      return res.status(500).json({ error: lastErr?.message || '文件删除失败 (仍被占用)' });
    }
    console.log('[delete] OK:', filePath);
    deleteLocalNote(filePath);
    res.json({ success: true });
  } catch (err) {
    console.error('[delete] error:', filePath, '-', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/local/file', (req, res) => {
  const { path: filePath, name } = req.body;
  if (!filePath || !name) return res.status(400).json({ error: '参数不完整' });
  try {
    const dir = path.dirname(filePath);
    const newPath = path.join(dir, name);
    fs.renameSync(filePath, newPath);
    remapLocalNotesPath(filePath, newPath);
    // Keep clips attached to the renamed file
    const clips = readLocalClips();
    let changed = false;
    for (const c of clips) {
      if (c.videoPath === filePath) { c.videoPath = newPath; changed = true; }
    }
    if (changed) writeLocalClips(clips);
    res.json({ success: true, newPath });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Folder Management ──
app.post('/api/local/folder', (req, res) => {
  const { parentPath, name } = req.body;
  if (!parentPath || !name) return res.status(400).json({ error: '参数不完整' });
  if (!pathIsAllowed(parentPath)) return res.status(403).json({ error: '该路径不在白名单中' });
  const newDir = path.join(parentPath, name.trim());
  try {
    fs.mkdirSync(newDir, { recursive: true });
    res.json({ success: true, path: newDir });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/local/folder', async (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(folderPath)) return res.status(403).json({ error: '该路径不在白名单中' });
  try {
    fs.rmSync(folderPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/local/folder', async (req, res) => {
  const { path: folderPath, name } = req.body;
  if (!folderPath || !name) return res.status(400).json({ error: '参数不完整' });
  try {
    const dir = path.dirname(folderPath);
    const newPath = path.join(dir, name);
    fs.renameSync(folderPath, newPath);
    res.json({ success: true, newPath });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/local/move-files', async (req, res) => {
  const { filePaths, destPath } = req.body;
  console.log('[move-files] request:', { filePaths, destPath });
  if (!filePaths?.length || !destPath) return res.status(400).json({ error: '参数不完整' });

  // Check destination exists
  if (!fs.existsSync(destPath) || !fs.statSync(destPath).isDirectory()) {
    return res.status(400).json({ error: '目标文件夹不存在: ' + destPath });
  }

  const moved = [];
  const errors = [];
  for (const fp of filePaths) {
    const dest = path.join(destPath, path.basename(fp));
    console.log('[move-files] attempting:', fp, '->', dest);
    try {
      // Try native rename first (fast, works on same volume)
      fs.renameSync(fp, dest);
      moved.push({ oldPath: fp, newPath: dest });
    } catch (renameErr) {
      // If rename fails (e.g. cross-volume), fall back to copy + delete
      if (renameErr.code === 'ENOENT') {
        console.error('[move-files] source not found:', fp);
        errors.push({ path: fp, error: '源文件不存在' });
        continue;
      }
      try {
        fs.copyFileSync(fp, dest);
        fs.unlinkSync(fp);
        moved.push({ oldPath: fp, newPath: dest });
      } catch (copyErr) {
        console.error('[move-files] failed for:', fp, copyErr.message);
        errors.push({ path: fp, error: copyErr.message });
      }
    }
  }
  if (moved.length) {
    const clips = readLocalClips();
    let clipsChanged = false;
    for (const m of moved) {
      remapLocalNotesPath(m.oldPath, m.newPath);
      for (const c of clips) {
        if (c.videoPath === m.oldPath) { c.videoPath = m.newPath; clipsChanged = true; }
      }
    }
    if (clipsChanged) writeLocalClips(clips);
  }
  console.log('[move-files] result:', { moved: moved.length, errors: errors.length });
  res.json({ success: true, moved, errors });
});

// ── Move folder (drag & drop in tree) ──
app.patch('/api/local/move-folder', async (req, res) => {
  const { folderPath, destPath } = req.body;
  if (!folderPath || !destPath) return res.status(400).json({ error: '参数不完整' });
  try {
    if (destPath === folderPath || destPath.startsWith(folderPath + path.sep)) {
      return res.status(400).json({ error: '不能将文件夹移动到自身或其子目录中' });
    }
    if (!fs.existsSync(destPath) || !fs.statSync(destPath).isDirectory()) {
      return res.status(400).json({ error: '目标文件夹不存在' });
    }
    const folderName = path.basename(folderPath);
    const newPath = path.join(destPath, folderName);
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ error: '目标位置已存在同名文件夹' });
    }
    fs.renameSync(folderPath, newPath);
    res.json({ success: true, newPath });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MKV to MP4 conversion (SSE streaming with progress) ──
// Audio codecs that browsers can play inside MP4 with stream-copy
const BROWSER_SAFE_AUDIO = new Set(['aac', 'mp3']);

function probeFirstAudioCodec(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], (err, stdout) => {
      if (err) return resolve('');
      resolve((stdout || '').trim().toLowerCase().split(/\r?\n/)[0] || '');
    });
  });
}

/** Build ffmpeg args for fast MKV→MP4: copy video; copy audio only if browser-safe, else AAC. */
function buildFastRemuxArgs(input, output, aCodec) {
  const base = ['-y', '-hide_banner', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-movflags', '+faststart'];
  if (BROWSER_SAFE_AUDIO.has(aCodec)) {
    return { args: [...base, '-c', 'copy', output], audioMode: 'copy' };
  }
  return {
    args: [...base, '-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-b:a', '192k', output],
    audioMode: aCodec ? 'aac-from-' + aCodec : 'aac'
  };
}

// ── Probe video info (duration, size) for quality estimation ──
app.get('/api/local/probe', (req, res) => {
  const filePath = req.query.filePath;
  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  execFile('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ], (err, stdout) => {
    const duration = err ? 0 : parseFloat(stdout.trim()) || 0;
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch {}
    res.json({ duration, size, presets: Object.entries(QUALITY_PRESETS).map(([key, p]) => ({
      key, name: p.name,
      estimatedSize: p.vbitrate > 0 ? Math.round((p.vbitrate + p.abitrate) * 1000 / 8 * duration) : size
    }))});
  });
});

// ── Full media metadata for detail "i" panel ──
app.get('/api/local/media-info', (req, res) => {
  const filePath = req.query.path || req.query.filePath;
  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: '该路径不在白名单中' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });

  let st = null;
  try { st = fs.statSync(filePath); } catch {}

  execFile('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ], { maxBuffer: 12 * 1024 * 1024 }, (err, stdout) => {
    let probe = null;
    if (!err && stdout) {
      try { probe = JSON.parse(stdout); } catch {}
    }
    const format = probe?.format || {};
    const streams = Array.isArray(probe?.streams) ? probe.streams : [];
    const videoStreams = streams.filter(s => s.codec_type === 'video').map(s => ({
      index: s.index,
      codec: s.codec_name || s.codec_long_name || '',
      profile: s.profile || '',
      width: s.width || 0,
      height: s.height || 0,
      pixFmt: s.pix_fmt || '',
      fps: (s.avg_frame_rate && s.avg_frame_rate !== '0/0') ? s.avg_frame_rate
        : ((s.r_frame_rate && s.r_frame_rate !== '0/0') ? s.r_frame_rate : ''),
      bitrate: parseInt(s.bit_rate, 10) || 0,
      duration: parseFloat(s.duration) || 0
    }));
    const audioStreams = streams.filter(s => s.codec_type === 'audio').map(s => ({
      index: s.index,
      codec: s.codec_name || s.codec_long_name || '',
      sampleRate: parseInt(s.sample_rate, 10) || 0,
      channels: s.channels || 0,
      channelLayout: s.channel_layout || '',
      bitrate: parseInt(s.bit_rate, 10) || 0,
      language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || ''
    }));
    const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle').map(s => ({
      index: s.index,
      codec: s.codec_name || '',
      language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || ''
    }));

    res.json({
      path: filePath,
      name: path.basename(filePath),
      size: st ? st.size : (parseInt(format.size, 10) || 0),
      birthtime: st ? st.birthtime.toISOString() : null,
      mtime: st ? st.mtime.toISOString() : null,
      duration: parseFloat(format.duration) || (videoStreams[0] && videoStreams[0].duration) || 0,
      bitrate: parseInt(format.bit_rate, 10) || 0,
      formatName: format.format_name || '',
      formatLongName: format.format_long_name || '',
      probeOk: !!probe,
      video: videoStreams,
      audio: audioStreams,
      subtitle: subtitleStreams
    });
  });
});

// ── Video conversion with SSE progress (supports any video format + quality presets) ──
app.get('/api/local/convert-mkv-stream', (req, res) => {
  const filePath = req.query.filePath;
  const quality = req.query.quality || 'copy';
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.copy;

  if (!filePath) return res.status(400).json({ error: '缺少路径' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
  const ext = path.extname(filePath).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return res.status(400).json({ error: '不支持的视频格式' });

  const isMkv = ext === '.mkv';
  const isCopy = quality === 'copy';

  // Copy mode only makes sense for MKV → MP4
  if (isCopy && !isMkv) return res.status(400).json({ error: '直接复制仅支持 MKV 文件' });

  // Build output path
  let mp4Path;
  if (isCopy) {
    // MKV → MP4 (same folder, replace extension)
    mp4Path = filePath.replace(/\.mkv$/i, '.mp4');
  } else {
    // Transcode: add quality suffix (e.g. movie_720p.mp4)
    const baseName = path.basename(filePath, ext);
    const dir = path.dirname(filePath);
    mp4Path = path.join(dir, `${baseName}_${quality}.mp4`);
  }
  if (fs.existsSync(mp4Path)) return res.status(400).json({ error: '输出文件已存在: ' + path.basename(mp4Path) });

  // SSE setup
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const send = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  // Get video duration with ffprobe
  execFile('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ], async (err, stdout) => {
    const totalDuration = err ? 0 : parseFloat(stdout.trim()) || 0;

    console.log('[convert-mkv] starting:', filePath, 'quality:', quality, 'duration:', totalDuration);

    // Build ffmpeg args based on quality
    const isCopy = quality === 'copy';
    let ffmpegProcess;

    if (isCopy) {
      // Fast remux: copy video; only copy audio if browser can play it in MP4
      const aCodec = await probeFirstAudioCodec(filePath);
      const { args, audioMode } = buildFastRemuxArgs(filePath, mp4Path, aCodec);
      console.log('[convert-mkv] copy mode audio:', aCodec || '(none)', '->', audioMode);
      if (audioMode !== 'copy') {
        send({ progress: 0, phase: aCodec ? `音频转 AAC (${aCodec})` : '封装中' });
      } else {
        send({ progress: 0, phase: '封装中' });
      }
      ffmpegProcess = execFile('ffmpeg', args, handleDone);
      attachProgress(ffmpegProcess, totalDuration, audioMode === 'copy' ? '封装中' : '音频转码中');
      req.on('close', () => killProcess(ffmpegProcess));
      return;
    } else {
      // Two-pass encoding
      const vBitrate = preset.vbitrate + 'k';
      const aBitrate = preset.abitrate + 'k';
      const passLogFile = path.join(UPLOADS, 'trimmed', `ffmpeg2pass_${Date.now()}`);

      const scaleFilter = preset.scale ? ['-vf', `scale=-2:${preset.scale}`] : null;
      const pass1Args = [
        '-y', '-i', filePath,
        '-map', '0:v:0',
        '-c:v', 'libx264', '-b:v', vBitrate,
        '-pass', '1', '-passlogfile', passLogFile,
        '-an', '-f', 'mp4', NULL_DEV
      ];
      if (scaleFilter) {
        const idx = pass1Args.indexOf('-c:v');
        pass1Args.splice(idx, 0, scaleFilter[0], scaleFilter[1]);
      }

      const pass2Args = [
        '-y', '-i', filePath,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-b:v', vBitrate,
        '-pass', '2', '-passlogfile', passLogFile,
        '-c:a', 'aac', '-b:a', aBitrate,
        mp4Path
      ];
      if (scaleFilter) {
        const idx = pass2Args.indexOf('-c:v');
        pass2Args.splice(idx, 0, scaleFilter[0], scaleFilter[1]);
      }

      // Pass 1
      send({ progress: 0, phase: '分析中' });
      const pass1 = execFile('ffmpeg', pass1Args, (err) => {
        if (err) {
          cleanupPassLog(passLogFile);
          handleDone(err);
          return;
        }
        // Pass 2
        send({ progress: 0, phase: '编码中' });
        ffmpegProcess = execFile('ffmpeg', pass2Args, (err) => {
          cleanupPassLog(passLogFile);
          handleDone(err);
        });
        // Parse pass 2 stderr for progress
        attachProgress(ffmpegProcess, totalDuration, '编码中');
        req.on('close', () => killProcess(ffmpegProcess));
      });

      // Parse pass 1 stderr for progress
      attachProgress(pass1, totalDuration, '分析中');
      req.on('close', () => killProcess(pass1));
      return;
    }
  });

  let completed = false;

  function handleDone(err) {
    completed = true;
    if (err) {
      try { fs.unlinkSync(mp4Path); } catch {}
      console.error('[convert] failed:', err.message);
      send({ error: '转换失败: ' + err.message });
      res.end();
    } else {
      // Keep original MKV; user deletes manually if desired
      console.log('[convert] done:', mp4Path);
      send({ done: true, newPath: mp4Path });
      res.end();
    }
  }

  function attachProgress(proc, duration, phase) {
    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const matches = stderrBuf.match(/time=(\d+:\d+:\d+\.\d+)/g);
      if (matches) {
        const last = matches[matches.length - 1];
        const timeStr = last.replace('time=', '');
        const parts = timeStr.split(':');
        const currentSec = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
        const progress = duration > 0 ? Math.min(100, Math.round((currentSec / duration) * 100)) : 0;
        send({ progress, time: timeStr.split('.')[0], phase });
        if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
      }
    });
  }

  function killProcess(proc) {
    if (completed) return; // Don't touch anything if conversion finished
    if (proc && !proc.killed) {
      proc.kill();
      try { fs.unlinkSync(mp4Path); } catch {}
    }
  }

  function cleanupPassLog(passLogFile) {
    try { fs.unlinkSync(passLogFile + '-0.log'); } catch {}
    try { fs.unlinkSync(passLogFile + '-0.log.mbtree'); } catch {}
  }
});

// ── MKV to MP4 conversion (upload mode for FSA/local) ──
const convertStorage = multer.diskStorage({
  destination: (_req, _f, cb) => cb(null, path.join(UPLOADS, 'trimmed')),
  filename: (_req, file, cb) => cb(null, `convert_${Date.now()}${path.extname(file.originalname).toLowerCase()}`)
});
const convertUpload = multer({ storage: convertStorage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

app.post('/api/local/convert-mkv-upload', convertUpload.single('file'), multerErrHandler, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未上传文件' });
  const inputPath = req.file.path;
  const mp4Name = path.basename(req.file.originalname, path.extname(req.file.originalname)) + '.mp4';
  const outputPath = path.join(UPLOADS, 'trimmed', `converted_${Date.now()}.mp4`);

  console.log('[convert-mkv-upload] starting:', inputPath);

  try {
    const aCodec = await probeFirstAudioCodec(inputPath);
    const { args, audioMode } = buildFastRemuxArgs(inputPath, outputPath, aCodec);
    console.log('[convert-mkv-upload] audio:', aCodec || '(none)', '->', audioMode);
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', args, (err, stdout, stderr) => {
        if (err) {
          console.error('[convert-mkv-upload] ffmpeg error:', stderr?.slice(-500));
          reject(err);
        } else resolve();
      });
    });

    // Clean up uploaded MKV
    try { fs.unlinkSync(inputPath); } catch {}

    console.log('[convert-mkv-upload] done:', outputPath);
    const downloadUrl = '/api/local/convert-download?file=' + encodeURIComponent(path.basename(outputPath)) + '&name=' + encodeURIComponent(mp4Name);
    res.json({ success: true, downloadUrl });
  } catch (err) {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
    console.error('[convert-mkv-upload] failed:', err.message);
    res.status(500).json({ error: '转换失败: ' + err.message });
  }
});

app.get('/api/local/convert-download', (req, res) => {
  const fileName = req.query.file;
  const displayName = req.query.name || 'converted.mp4';
  if (!fileName) return res.status(400).send('No file');
  const filePath = path.join(UPLOADS, 'trimmed', fileName);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath, displayName, () => {
    // Clean up after download
    setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 5000);
  });
});

// ═══════════════════════════════════════════════════════
// ── Local Upload & Cover API ──
// ═══════════════════════════════════════════════════════

const localUploadStorage = multer.diskStorage({
  destination: (_req, _f, cb) => {
    const tmpDir = path.join(UPLOADS, 'tmp-uploads');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (_req, file, cb) => {
    // Safe filename: strip path separators, limit length
    const safe = file.originalname.replace(/[/\\]/g, '_').substring(0, 200);
    cb(null, Date.now() + '_' + safe);
  }
});
const localUpload = multer({ storage: localUploadStorage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

app.post('/api/local/upload-video', (req, res, next) => {
  localUpload.array('files', 50)(req, res, (err) => {
    if (err) {
      console.error('[upload] multer error:', err.message, err.code);
      return res.status(400).json({ error: '上传错误: ' + err.message });
    }
    console.log('[upload] files received:', req.files ? req.files.length : 0);
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: '没有上传文件' });

    // Determine target folder
    const wl = readWhitelist();
    let targetFolder;
    const reqFolder = req.body && req.body.folderPath;
    if (reqFolder && typeof reqFolder === 'string' && reqFolder.trim()) {
      targetFolder = reqFolder.trim();
    } else if (wl.length > 0) {
      targetFolder = path.join(wl[0], 'NewUpload');
    } else {
      targetFolder = path.join(UPLOADS, 'NewUpload');
    }
    if (!pathIsAllowed(targetFolder)) return res.status(403).json({ error: '路径不在白名单中' });
    if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder, { recursive: true });

    // Move files from temp to target
    const moved = [];
    for (const f of req.files) {
      // Fix UTF-8 filenames garbled by multer's latin1 default decoding
      let origName = f.originalname;
      try { origName = Buffer.from(origName, 'latin1').toString('utf8'); } catch (e) {}
      const safeName = origName.replace(/[/\\]/g, '_').substring(0, 200);
      const destPath = path.join(targetFolder, safeName);
      try {
        fs.renameSync(f.path, destPath);
        moved.push({ name: safeName, path: destPath, size: f.size });
      } catch (e) {
        // If rename fails (cross-device), copy instead
        try {
          fs.copyFileSync(f.path, destPath);
          fs.unlinkSync(f.path);
          moved.push({ name: safeName, path: destPath, size: f.size });
        } catch (e2) {
          try { fs.unlinkSync(f.path); } catch {}
        }
      }
    }

    res.json({ success: true, files: moved, count: moved.length, folder: targetFolder });
  });
});

app.post('/api/local/set-cover', (req, res) => {
  const { videoPath, imageData } = req.body;
  if (!videoPath || !imageData) return res.status(400).json({ error: '参数不完整' });
  if (!pathIsAllowed(videoPath)) return res.status(403).json({ error: '路径不在白名单中' });

  // Manual cover: hash based on path only (no time), so it always shows regardless of slider
  const hash = require('crypto').createHash('md5').update(videoPath).digest('hex');
  const thumbPath = path.join(LOCAL_THUMB_DIR, hash + '.manual.jpg');
  console.log('[set-cover] saving to:', thumbPath);

  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  fs.writeFileSync(thumbPath, buffer);
  res.json({ success: true, thumbPath });
});

app.delete('/api/local/cover', (req, res) => {
  const videoPath = req.query.path;
  console.log('[clear-cover] request path:', videoPath);
  if (!videoPath) return res.status(400).json({ error: '缺少路径' });
  if (!pathIsAllowed(videoPath)) return res.status(403).json({ error: '路径不在白名单中' });

  // Manual cover: hash based on path only (no time)
  const hash = require('crypto').createHash('md5').update(videoPath).digest('hex');
  const manualPath = path.join(LOCAL_THUMB_DIR, hash + '.manual.jpg');
  console.log('[clear-cover] checking:', manualPath, 'exists:', fs.existsSync(manualPath));

  try {
    if (fs.existsSync(manualPath)) fs.unlinkSync(manualPath);
    console.log('[clear-cover] done, file deleted');
    res.json({ success: true });
  } catch (e) {
    console.error('[clear-cover] error:', e.message);
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

app.get('/api/local/has-cover', (req, res) => {
  const videoPath = req.query.path;
  if (!videoPath) return res.status(400).json({ hasCover: false });
  const hash = require('crypto').createHash('md5').update(videoPath).digest('hex');
  const manualPath = path.join(LOCAL_THUMB_DIR, hash + '.manual.jpg');
  const exists = fs.existsSync(manualPath) && fs.statSync(manualPath).size > 500;
  console.log('[has-cover] path:', videoPath, 'manual:', manualPath, 'exists:', exists);
  res.json({ hasCover: exists });
});

// ═══════════════════════════════════════════════════════
// ── Super Converter API ──
// ═══════════════════════════════════════════════════════

const HANDBRAKE = 'HandBrakeCLI';
const CONVERT_HISTORY = path.join(BASE, 'data', 'convert-history.log');

// SSE helper for converter endpoints
function sseSetup(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  return (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
}

// Search files/folders by keyword within a base path
app.get('/api/convert/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const type = req.query.type || 'file'; // file | folder
  const basePath = req.query.basePath || '';
  if (!q) return res.json([]);
  if (!basePath || !fs.existsSync(basePath)) return res.json([]);
  if (!pathIsAllowed(basePath)) return res.status(403).json({ error: '路径不在白名单中' });

  const results = [];
  const MAX = 50;
  function walk(dir) {
    if (results.length >= MAX) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (results.length >= MAX) return;
        const full = path.join(dir, e.name);
        if (type === 'folder' && e.isDirectory() && e.name.toLowerCase().includes(q)) {
          results.push({ name: e.name, path: full });
        }
        if (type === 'file' && e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()) && e.name.toLowerCase().includes(q)) {
          let size = 0;
          try { size = fs.statSync(full).size; } catch {}
          results.push({ name: e.name, path: full, size });
        }
        if (type === 'subtitle' && e.isFile() && ['.srt','.ass','.ssa','.vtt'].includes(path.extname(e.name).toLowerCase()) && e.name.toLowerCase().includes(q)) {
          results.push({ name: e.name, path: full });
        }
        if (e.isDirectory()) walk(full);
      }
    } catch {}
  }
  walk(basePath);
  res.json(results);
});

// 1. Extract subtitle from video (ffmpeg)
app.get('/api/convert/extract-sub', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: '文件不存在' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: '路径不在白名单中' });

  const send = sseSetup(res);
  const baseName = path.basename(filePath, path.extname(filePath));
  const dir = path.dirname(filePath);
  const outSrt = path.join(dir, baseName + '.zh.srt');

  send({ type: 'start', file: path.basename(filePath), output: path.basename(outSrt) });

  const proc = spawn('ffmpeg', ['-y', '-i', filePath, '-map', 's:0?', outSrt]);
  proc.stderr.on('data', d => {
    const line = d.toString();
    if (line.includes('time=')) {
      const m = line.match(/time=(\S+)/);
      if (m) send({ type: 'progress', time: m[1] });
    }
  });
  proc.on('close', code => {
    if (code === 0 && fs.existsSync(outSrt) && fs.statSync(outSrt).size > 0) {
      send({ type: 'done', output: outSrt });
    } else {
      try { fs.unlinkSync(outSrt); } catch {}
      send({ type: 'error', msg: '提取失败：视频中没有内嵌软字幕轨' });
    }
    res.end();
  });
  proc.on('error', err => { send({ type: 'error', msg: err.message }); res.end(); });
});

// 2. Merge subtitle into MP4 (ffmpeg copy)
app.get('/api/convert/merge-sub', (req, res) => {
  const videoPath = req.query.video;
  const subPath = req.query.sub;
  if (!videoPath || !subPath || !fs.existsSync(videoPath) || !fs.existsSync(subPath)) {
    return res.status(400).json({ error: '视频或字幕文件不存在' });
  }
  if (!pathIsAllowed(videoPath)) return res.status(403).json({ error: '路径不在白名单中' });

  const send = sseSetup(res);
  const ext = path.extname(videoPath);
  const baseName = path.basename(videoPath, ext);
  const dir = path.dirname(videoPath);
  const tmpOut = path.join(dir, baseName + '.subbed.mp4');

  send({ type: 'start', file: path.basename(videoPath), sub: path.basename(subPath) });

  const args = ['-y', '-i', videoPath, '-i', subPath, '-c', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=chi', '-metadata:s:s:0', 'title=Chs', tmpOut];
  const proc = spawn('ffmpeg', args);
  proc.stderr.on('data', d => {
    const line = d.toString();
    if (line.includes('time=')) {
      const m = line.match(/time=(\S+)/);
      if (m) send({ type: 'progress', time: m[1] });
    }
  });
  proc.on('close', code => {
    if (code === 0 && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0) {
      // Safe 3-step rename: backup original → move new → delete backup
      const bakPath = videoPath + '.bak';
      try {
        if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
        fs.renameSync(videoPath, bakPath);
        fs.renameSync(tmpOut, videoPath);
        fs.unlinkSync(bakPath);
      } catch (renameErr) {
        // Try to restore from backup
        try { if (fs.existsSync(bakPath) && !fs.existsSync(videoPath)) fs.renameSync(bakPath, videoPath); } catch {}
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        send({ type: 'error', msg: '合并成功但替换原文件失败: ' + renameErr.message });
        res.end();
        return;
      }
      send({ type: 'done', output: videoPath });
    } else {
      try { fs.unlinkSync(tmpOut); } catch {}
      send({ type: 'error', msg: '合并失败' });
    }
    res.end();
  });
  proc.on('error', err => { send({ type: 'error', msg: err.message }); res.end(); });
});

// 3. Single file convert (HandBrakeCLI - fix audio)
app.get('/api/convert/single', (req, res) => {
  const filePath = req.query.path;
  const encoder = req.query.encoder || 'x265';
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: '文件不存在' });
  if (!pathIsAllowed(filePath)) return res.status(403).json({ error: '路径不在白名单中' });

  const send = sseSetup(res);
  const ext = path.extname(filePath);
  const isMp4 = ext.toLowerCase() === '.mp4';
  const baseName = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const outFile = isMp4 ? path.join(dir, baseName + '.fixed.mp4') : path.join(dir, baseName + '.mp4');

  send({ type: 'start', file: path.basename(filePath), encoder });

  // Get duration for progress
  execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath], (err, stdout) => {
    const totalSec = err ? 0 : parseFloat(stdout.trim()) || 0;

    const args = ['-i', filePath, '-o', outFile,
      '-e', encoder, '-q', '26',
      '--maxHeight', '1080', '--maxWidth', '1920',
      '-r', '30', '--vfr',
      '-a', '1', '-E', 'avc_aac', '-B', '160', '--mixdown', 'stereo'];
    const proc = spawn(HANDBRAKE, args);
    proc.stderr.on('data', d => {
      const line = d.toString();
      // HandBrakeCLI progress: "Encoding: task 1 of 1, 45.23 % (24.12 fps, avg 25.00 fps, ETA 00h12m30s)"
      const m = line.match(/(\d+\.?\d*)\s*%/);
      if (m) send({ type: 'progress', percent: parseFloat(m[1]) });
    });
    proc.stdout.on('data', d => {
      const line = d.toString();
      const m = line.match(/(\d+\.?\d*)\s*%/);
      if (m) send({ type: 'progress', percent: parseFloat(m[1]) });
    });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        if (isMp4) {
          const bak = filePath + '.bak';
          try {
            if (fs.existsSync(bak)) fs.unlinkSync(bak);
            fs.renameSync(filePath, bak);
            fs.renameSync(outFile, filePath);
            fs.unlinkSync(bak);
          } catch (e) {
            console.warn('[convert/single] rename failed, original preserved:', e.message);
            try { if (fs.existsSync(bak) && !fs.existsSync(filePath)) fs.renameSync(bak, filePath); } catch {}
            try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch {}
          }
        }
        send({ type: 'done', output: isMp4 ? filePath : outFile });
      } else {
        try { fs.unlinkSync(outFile); } catch {}
        send({ type: 'error', msg: '转换失败' });
      }
      res.end();
    });
    proc.on('error', err => { send({ type: 'error', msg: err.message }); res.end(); });
  });
});

// 4. Folder batch convert (HandBrakeCLI)
app.get('/api/convert/folder', (req, res) => {
  const folderPath = req.query.path;
  const encoder = req.query.encoder || 'x265';
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    return res.status(400).json({ error: '文件夹不存在' });
  }
  if (!pathIsAllowed(folderPath)) return res.status(403).json({ error: '路径不在白名单中' });

  const send = sseSetup(res);
  const videos = [];
  function scan(dir) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
          videos.push(path.join(dir, e.name));
        } else if (e.isDirectory()) scan(path.join(dir, e.name));
      }
    } catch {}
  }
  scan(folderPath);

  if (!videos.length) { send({ type: 'error', msg: '文件夹中没有视频文件' }); return res.end(); }
  send({ type: 'start', total: videos.length });

  let idx = 0;
  function next() {
    if (idx >= videos.length) { send({ type: 'done', total: videos.length }); return res.end(); }
    const fp = videos[idx];
    const ext = path.extname(fp);
    const isMp4 = ext.toLowerCase() === '.mp4';
    const baseName = path.basename(fp, ext);
    const dir = path.dirname(fp);
    const outFile = isMp4 ? path.join(dir, baseName + '.fixed.mp4') : path.join(dir, baseName + '.mp4');

    send({ type: 'file', index: idx + 1, total: videos.length, name: path.basename(fp) });

    const args = ['-i', fp, '-o', outFile,
      '-e', encoder, '-q', '26',
      '--maxHeight', '1080', '--maxWidth', '1920',
      '-r', '30', '--vfr',
      '-a', '1', '-E', 'avc_aac', '-B', '160', '--mixdown', 'stereo'];
    const proc = spawn(HANDBRAKE, args);
    proc.stderr.on('data', d => {
      const m = d.toString().match(/(\d+\.?\d*)\s*%/);
      if (m) send({ type: 'progress', fileIdx: idx + 1, total: videos.length, percent: parseFloat(m[1]) });
    });
    proc.stdout.on('data', d => {
      const m = d.toString().match(/(\d+\.?\d*)\s*%/);
      if (m) send({ type: 'progress', fileIdx: idx + 1, total: videos.length, percent: parseFloat(m[1]) });
    });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        if (isMp4) {
          const bak = fp + '.bak';
          try {
            if (fs.existsSync(bak)) fs.unlinkSync(bak);
            fs.renameSync(fp, bak);
            fs.renameSync(outFile, fp);
            fs.unlinkSync(bak);
          } catch (e) {
            console.warn('[convert/folder] rename failed, original preserved:', e.message);
            try { if (fs.existsSync(bak) && !fs.existsSync(fp)) fs.renameSync(bak, fp); } catch {}
            try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch {}
          }
        }
        send({ type: 'file-done', index: idx + 1, total: videos.length, name: path.basename(fp) });
      } else {
        try { fs.unlinkSync(outFile); } catch {}
        send({ type: 'file-error', index: idx + 1, name: path.basename(fp), msg: '转换失败' });
      }
      idx++;
      next();
    });
    proc.on('error', err => {
      send({ type: 'file-error', index: idx + 1, name: path.basename(fp), msg: err.message });
      idx++;
      next();
    });
  }
  next();
});

// 5. Batch transcode all MKV → MP4 (HandBrakeCLI with history log)
app.get('/api/convert/batch', (req, res) => {
  const basePath = req.query.path;
  const encoder = req.query.encoder || 'x265';
  const limit = parseInt(req.query.limit) || 0; // 0 = all
  if (!basePath || !fs.existsSync(basePath)) return res.status(400).json({ error: '路径不存在' });
  if (!pathIsAllowed(basePath)) return res.status(403).json({ error: '路径不在白名单中' });

  const send = sseSetup(res);

  // Load history
  let history = new Set();
  try {
    if (fs.existsSync(CONVERT_HISTORY)) {
      fs.readFileSync(CONVERT_HISTORY, 'utf-8').split('\n').forEach(l => { if (l.trim()) history.add(l.trim()); });
    }
  } catch {}

  const mkvs = [];
  function scan(dir) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && path.extname(e.name).toLowerCase() === '.mkv') {
          mkvs.push(path.join(dir, e.name));
        } else if (e.isDirectory()) scan(path.join(dir, e.name));
      }
    } catch {}
  }
  scan(basePath);

  // Filter by history
  const pending = mkvs.filter(f => {
    const rel = path.relative(basePath, f).replace(/\\/g, '/');
    return !history.has(rel);
  });

  if (!pending.length) { send({ type: 'done', total: 0, skipped: mkvs.length }); return res.end(); }

  const toProcess = limit > 0 ? pending.slice(0, limit) : pending;
  send({ type: 'start', total: toProcess.length, found: mkvs.length, skipped: mkvs.length - pending.length });

  let idx = 0;
  function next() {
    if (idx >= toProcess.length) { send({ type: 'done', total: toProcess.length }); return res.end(); }
    const fp = toProcess[idx];
    const rel = path.relative(basePath, fp).replace(/\\/g, '/');
    const outFile = fp.replace(/\.mkv$/i, '.mp4');

    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      // Already exists
      try { fs.appendFileSync(CONVERT_HISTORY, rel + '\n'); } catch {}
      send({ type: 'file-skip', index: idx + 1, name: path.basename(fp) });
      idx++;
      return next();
    }

    send({ type: 'file', index: idx + 1, total: toProcess.length, name: path.basename(fp) });

    const args = ['-i', fp, '-o', outFile,
      '-e', encoder, '--maxHeight', '1080', '--maxWidth', '1920',
      '-r', '30', '--vfr',
      '--audio-lang-list', 'cmn,chi,eng',
      '--subtitle-lang-list', 'chi,zho'];
    const proc = spawn(HANDBRAKE, args);
    proc.stderr.on('data', d => {
      const m = d.toString().match(/(\d+\.?\d*)\s*%/);
      if (m) send({ type: 'progress', fileIdx: idx + 1, total: toProcess.length, percent: parseFloat(m[1]) });
    });
    proc.stdout.on('data', d => {
      const m = d.toString().match(/(\d+\.?\d*)\s*%/);
      if (m) send({ type: 'progress', fileIdx: idx + 1, total: toProcess.length, percent: parseFloat(m[1]) });
    });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        try { fs.appendFileSync(CONVERT_HISTORY, rel + '\n'); } catch {}
        send({ type: 'file-done', index: idx + 1, total: toProcess.length, name: path.basename(fp) });
      } else {
        try { fs.unlinkSync(outFile); } catch {}
        send({ type: 'file-error', index: idx + 1, name: path.basename(fp), msg: '转码失败' });
      }
      idx++;
      next();
    });
    proc.on('error', err => {
      send({ type: 'file-error', index: idx + 1, name: path.basename(fp), msg: err.message });
      idx++;
      next();
    });
  }
  next();
});

function startServer() {
  app.listen(PORT, '0.0.0.0', () => {
    const wl = readWhitelist();
    const localUrl = `http://localhost:${PORT}`;
    console.log(`Tricks Collection running at ${localUrl}`);
  if (wl.length > 0) {
    console.log(`[whitelist] active (${wl.length} directories):`);
    wl.forEach(d => console.log('  -', d));
  } else {
    console.log('[whitelist] none configured, all paths allowed');
  }

  // System tray (Windows, optional — skip if systray unavailable)
  try {
    const SysTray = require('systray').default;
    const icoPath = path.join(PUBLIC_DIR, 'tray-icon.ico');

    const setupTray = (icon) => {
      const tray = new SysTray({
        menu: {
          icon: icon,
          title: 'Tricks Collection',
          tooltip: `Tricks Collection - localhost:${PORT}`,
          items: [
            { title: '打开浏览器', tooltip: '', checked: false, enabled: true },
            { title: '退出', tooltip: '', checked: false, enabled: true }
          ]
        },
        debug: false,
        copyDir: !!process.pkg
      });
      tray.onClick((action) => {
        if (action.item.title === '打开浏览器') {
          const { exec: ex } = require('child_process');
          ex(`start ${localUrl}`);
        } else if (action.item.title === '退出') {
          tray.kill();
          process.exit(0);
        }
      });
      tray.onError((err) => {
        console.error('[tray] error:', err);
      });
      tray.onExit((code) => {
        console.log('[tray] process exited with code', code);
      });
    };

    if (fs.existsSync(icoPath)) {
      setupTray(fs.readFileSync(icoPath).toString('base64'));
      console.log('[tray] system tray icon created');
    } else {
      console.log('[tray] icon not found at', icoPath);
    }
  } catch (e) {
    console.log('[tray] systray not available:', e.message);
  }
  });
}

if (RESTART_DELAY > 0) {
  console.log(`[restart] waiting ${RESTART_DELAY}ms before binding port ${PORT}...`);
  setTimeout(startServer, RESTART_DELAY);
} else {
  startServer();
}
