/* ============================================================
   Klang PWA – lokaler Offline-Musikplayer
   Songs in IndexedDB, Wiedergabe via <audio>. Kein Server nötig.
   ============================================================ */
'use strict';

/* ---------------- IndexedDB ---------------- */
const DB_NAME = 'klang';
const DB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) {
        const s = db.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('fileName', 'fileName', { unique: false });
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) { return _db.transaction(store, mode).objectStore(store); }
function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbAll(store) {
  return new Promise((res, rej) => {
    const out = [];
    const c = tx(store, 'readonly').openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } else res(out); };
    c.onerror = () => rej(c.error);
  });
}

async function dbAddSong(song) { return idbReq(tx('songs', 'readwrite').add(song)); }
async function dbPutSong(song) { return idbReq(tx('songs', 'readwrite').put(song)); }
async function dbGetSong(id) { return idbReq(tx('songs', 'readonly').get(id)); }
async function dbDeleteSong(id) { return idbReq(tx('songs', 'readwrite').delete(id)); }
async function dbAllSongs() { return idbAll('songs'); }
async function dbAllPlaylists() { return idbAll('playlists'); }
async function dbAddPlaylist(p) { return idbReq(tx('playlists', 'readwrite').add(p)); }
async function dbPutPlaylist(p) { return idbReq(tx('playlists', 'readwrite').put(p)); }
async function dbDeletePlaylist(id) { return idbReq(tx('playlists', 'readwrite').delete(id)); }
async function dbGetPlaylist(id) { return idbReq(tx('playlists', 'readonly').get(id)); }

/* ---------------- ID3v2-Parser (minimal) ---------------- */
function parseId3(bytes) {
  const out = { title: null, artist: null, album: null, picture: null };
  try {
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return out;
    const major = bytes[3];
    const synch = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d;
    const tagSize = synch(bytes[6], bytes[7], bytes[8], bytes[9]);
    let pos = 10;
    const end = Math.min(bytes.length, 10 + tagSize);
    const readSize = (a, b, c, d) => (major === 4 ? synch(a, b, c, d) : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
    while (pos + 10 <= end) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      if (id === '\0\0\0\0' || !/^[A-Z0-9]{4}$/.test(id)) break;
      const size = readSize(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const fstart = pos + 10;
      if (size <= 0 || fstart + size > end) break;
      const frame = bytes.subarray(fstart, fstart + size);
      if (id === 'TIT2') out.title = decodeText(frame);
      else if (id === 'TPE1') out.artist = decodeText(frame);
      else if (id === 'TALB') out.album = decodeText(frame);
      else if (id === 'APIC') out.picture = decodeApic(frame);
      pos = fstart + size;
    }
  } catch { /* tolerant */ }
  return out;
}

function decodeText(frame) {
  if (!frame.length) return null;
  const s = decodeByEncoding(frame[0], frame.subarray(1));
  return s ? s.replace(/\0+$/, '').trim() || null : null;
}
function decodeByEncoding(enc, data) {
  try {
    if (enc === 0) return new TextDecoder('iso-8859-1').decode(data);
    if (enc === 1) return new TextDecoder('utf-16').decode(data);
    if (enc === 2) return new TextDecoder('utf-16be').decode(data);
    return new TextDecoder('utf-8').decode(data);
  } catch { return ''; }
}
function decodeApic(frame) {
  try {
    let i = 1;
    const mimeStart = i;
    while (i < frame.length && frame[i] !== 0) i++;
    const mime = new TextDecoder('iso-8859-1').decode(frame.subarray(mimeStart, i)) || 'image/jpeg';
    i += 2; // null + picture type
    const enc = frame[0];
    if (enc === 1 || enc === 2) { while (i + 1 < frame.length && !(frame[i] === 0 && frame[i + 1] === 0)) i += 2; i += 2; }
    else { while (i < frame.length && frame[i] !== 0) i++; i++; }
    const data = frame.subarray(i);
    if (!data.length) return null;
    return { mime, data: new Uint8Array(data) };
  } catch { return null; }
}

/* ---------------- Helfer ---------------- */
function deriveTitle(name) {
  let t = name.replace(/\.[^.]+$/, '');
  t = t.replace(/_[A-Za-z0-9_-]{11}$/, '');
  return t.trim() || 'Unbekannter Titel';
}
function basename(p) { const a = p.split(/[/\\]/); return a[a.length - 1]; }
function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function plural(n) { return n === 1 ? '' : 's'; }

/* ---------------- Import (Songs) ---------------- */
const importOverlay = document.getElementById('importOverlay');
const importMsg = document.getElementById('importMsg');

async function importFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  importOverlay.classList.remove('hidden');
  let added = 0, skipped = 0;
  const existing = new Set((await dbAllSongs()).map((s) => s.fileName));
  try {
    for (const file of files) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip') || file.type.includes('zip')) {
        importMsg.textContent = 'Entpacke ' + file.name + '…';
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = fflate.unzipSync(buf);
        for (const path of Object.keys(entries)) {
          if (!path.toLowerCase().endsWith('.mp3')) continue;
          if (path.includes('__MACOSX')) continue;
          const fn = basename(path);
          if (existing.has(fn)) { skipped++; continue; }
          importMsg.textContent = 'Importiere ' + fn + '…';
          await addSongFromBytes(entries[path], fn);
          existing.add(fn); added++;
        }
      } else if (lower.endsWith('.mp3') || file.type.includes('audio') || file.type.includes('mpeg')) {
        const fn = basename(file.name);
        if (existing.has(fn)) { skipped++; continue; }
        importMsg.textContent = 'Importiere ' + fn + '…';
        await addSongFromBytes(new Uint8Array(await file.arrayBuffer()), fn);
        existing.add(fn); added++;
      } else {
        skipped++;
      }
    }
  } catch (e) {
    toast('Importfehler: ' + (e && e.message ? e.message : e), true);
  } finally {
    importOverlay.classList.add('hidden');
  }
  await refreshLibrary();
  if (added) toast(added + ' Song' + plural(added) + ' importiert' + (skipped ? ' · ' + skipped + ' übersprungen' : ''));
  else if (skipped) toast('Schon vorhanden – nichts importiert');
  else toast('Keine MP3s gefunden', true);
}

async function addSongFromBytes(bytes, fileName) {
  const tags = parseId3(bytes);
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const artwork = tags.picture && tags.picture.data.length
    ? new Blob([tags.picture.data], { type: tags.picture.mime }) : null;
  return await dbAddSong({
    title: tags.title || deriveTitle(fileName), artist: tags.artist || null, album: tags.album || null,
    fileName, blob, artwork, duration: 0, favorite: false, dateAdded: Date.now(),
  });
}

/* ---------------- Playlist Import / Export (.zip) ---------------- */
async function importPlaylistZip(file) {
  importOverlay.classList.remove('hidden');
  importMsg.textContent = 'Entpacke ' + file.name + '…';
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const entries = fflate.unzipSync(buf);

    // Name + optionale Reihenfolge aus Manifest
    let name = file.name.replace(/\.(klang\.)?zip$/i, '');
    let order = null;
    if (entries['klang-playlist.json']) {
      try {
        const m = JSON.parse(new TextDecoder().decode(entries['klang-playlist.json']));
        if (m.name) name = m.name;
        if (Array.isArray(m.files)) order = m.files.map(basename);
      } catch { /* ignorieren */ }
    }

    const mp3paths = Object.keys(entries).filter((p) => p.toLowerCase().endsWith('.mp3') && !p.includes('__MACOSX'));
    if (!mp3paths.length) { toast('Keine MP3s im ZIP', true); return; }

    const byBase = {};
    for (const p of mp3paths) byBase[basename(p)] = p;
    const seq = (order && order.length) ? order : mp3paths.map(basename);

    const existing = new Map((await dbAllSongs()).map((s) => [s.fileName, s.id]));
    const ids = [];
    let imported = 0;
    for (const base of seq) {
      const path = byBase[base];
      if (!path) continue;
      let id = existing.get(base);
      if (id == null) {
        importMsg.textContent = 'Importiere ' + base + '…';
        id = await addSongFromBytes(entries[path], base);
        existing.set(base, id); imported++;
      }
      if (!ids.includes(id)) ids.push(id);
    }

    const plId = await dbAddPlaylist({ name, songIds: ids, dateCreated: Date.now() });
    await refreshLibrary();
    toast(`Playlist „${name}“ importiert · ${ids.length} Song${plural(ids.length)}` + (imported ? ` (${imported} neu)` : ''));
    document.querySelector('.tab[data-view="playlists"]').click();
    openPlaylistDetail(plId);
  } catch (e) {
    toast('Importfehler: ' + (e && e.message ? e.message : e), true);
  } finally {
    importOverlay.classList.add('hidden');
  }
}

/* Minimaler ZIP-Writer (Store/unkomprimiert – MP3s sind schon komprimiert).
   Unabhängig vom fflate-Build, der nur Entpacken kann. */
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function buildZipStore(files) {
  const enc = new TextEncoder();
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const parts = [];
  const central = [];
  let offset = 0;
  const names = Object.keys(files);
  for (const name of names) {
    const data = files[name];
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const size = data.length;
    const lh = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length), ...u16(0)]);
    parts.push(lh, nameBytes, data);
    const localOffset = offset;
    offset += lh.length + nameBytes.length + size;
    central.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(localOffset)]), nameBytes);
  }
  let centralSize = 0; for (const c of central) centralSize += c.length;
  const eocd = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(names.length), ...u16(names.length),
    ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, eocd];
  let total = 0; for (const a of all) total += a.length;
  const out = new Uint8Array(total);
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

async function exportPlaylist(p) {
  const songs = p.songIds.map((id) => library.find((s) => s.id === id)).filter(Boolean);
  if (!songs.length) { toast('Playlist ist leer', true); return; }
  importOverlay.classList.remove('hidden');
  importMsg.textContent = 'Exportiere „' + p.name + '“…';
  try {
    const files = {};
    const usedNames = new Set();
    const manifest = { klang: 1, name: p.name, files: [] };
    for (const s of songs) {
      let fn = s.fileName || ((s.title || 'song') + '.mp3');
      if (!/\.mp3$/i.test(fn)) fn += '.mp3';
      let base = fn, n = 1;
      while (usedNames.has(base)) { base = fn.replace(/\.mp3$/i, '') + '_' + (n++) + '.mp3'; }
      usedNames.add(base);
      files[base] = new Uint8Array(await s.blob.arrayBuffer());
      manifest.files.push(base);
    }
    files['klang-playlist.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const zipped = buildZipStore(files);
    const blob = new Blob([zipped], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = p.name.replace(/[^\w\s.-]/g, '_') + '.klang.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast('Playlist exportiert – im Teilen-Menü speichern/senden');
  } catch (e) {
    toast('Exportfehler: ' + (e && e.message ? e.message : e), true);
  } finally {
    importOverlay.classList.add('hidden');
  }
}

/* ---------------- Artwork-URLs (gecacht) ---------------- */
const artCache = new Map();
function artUrl(song) {
  if (!song || !song.artwork) return './icons/icon.png';
  if (artCache.has(song.id)) return artCache.get(song.id);
  const u = URL.createObjectURL(song.artwork);
  artCache.set(song.id, u);
  return u;
}
function dropArt(id) { if (artCache.has(id)) { URL.revokeObjectURL(artCache.get(id)); artCache.delete(id); } }

/* ---------------- Player ---------------- */
const audio = new Audio();
audio.preload = 'auto';
let library = [];
let baseQueue = [];        // Songs in Originalreihenfolge (für Shuffle-Umschalten)
let queue = [];            // tatsächliche Abspielreihenfolge
let qIndex = -1;
let repeat = 'all';        // off | all | one  – Standard: ganze Liste wiederholen (Loop)
let shuffle = false;
let curUrl = null;

function currentSong() { return qIndex >= 0 ? queue[qIndex] : null; }

function shuffleArr(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

/* Startet die Wiedergabe einer Songliste.
   startIndex: Index in songs (oder null = von vorne / bei Shuffle komplett zufällig)
   forceShuffle: true/false setzt den Shuffle-Modus, undefined behält ihn bei */
function playQueue(songs, startIndex, forceShuffle) {
  if (!songs || !songs.length) return;
  baseQueue = songs.slice();
  if (forceShuffle === true) shuffle = true;
  else if (forceShuffle === false) shuffle = false;
  updateShuffleIcon();

  const startSong = (startIndex != null && startIndex >= 0 && startIndex < baseQueue.length)
    ? baseQueue[startIndex] : null;

  if (shuffle) {
    if (startSong) queue = [startSong, ...shuffleArr(baseQueue.filter((s) => s !== startSong))];
    else queue = shuffleArr(baseQueue);            // „Zufällig"-Button: auch erster Song zufällig
  } else {
    queue = baseQueue.slice();
  }
  qIndex = startSong ? queue.indexOf(startSong) : 0;
  if (qIndex < 0) qIndex = 0;
  loadAndPlay(true);
}

function playNext(songIds) {
  const songs = songIds.map((id) => library.find((s) => s.id === id)).filter(Boolean);
  if (!songs.length) return;
  if (qIndex < 0 || !queue.length) { playQueue(songs, 0); openNowPlaying(); return; }
  queue.splice(qIndex + 1, 0, ...songs);
  baseQueue.splice(baseQueue.indexOf(currentSong()) + 1, 0, ...songs);
  toast(songs.length === 1 ? 'Wird als Nächstes gespielt' : `${songs.length} Songs in Warteschlange`);
}

function loadAndPlay(play) {
  const song = currentSong();
  if (!song) return;
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  curUrl = URL.createObjectURL(song.blob);
  audio.src = curUrl;
  audio.loop = (repeat === 'one');
  if (play) audio.play().catch(() => {});
  updatePlayerUI();
  updateMediaSession();
  renderSongList();
}

function togglePlay() {
  if (!currentSong()) return;
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
function next(auto) {
  if (!queue.length) return;
  let ni = qIndex + 1;
  if (ni >= queue.length) { if (repeat === 'all') ni = 0; else { if (auto) { audio.pause(); audio.currentTime = 0; } return; } }
  qIndex = ni; loadAndPlay(true);
}
function prev() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let pi = qIndex - 1;
  if (pi < 0) { if (repeat === 'all') pi = queue.length - 1; else { audio.currentTime = 0; return; } }
  qIndex = pi; loadAndPlay(true);
}

audio.addEventListener('ended', () => { if (repeat !== 'one') next(true); });
audio.addEventListener('play', updatePlayPauseIcons);
audio.addEventListener('pause', updatePlayPauseIcons);
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  document.getElementById('curTime').textContent = fmtTime(audio.currentTime);
  document.getElementById('durTime').textContent = fmtTime(d);
  if (!seeking && d > 0) document.getElementById('seek').value = String((audio.currentTime / d) * 1000);
  const s = currentSong();
  if (s && d > 0 && (!s.duration || s.duration <= 0)) { s.duration = d; dbPutSong(s).catch(() => {}); }
});
audio.addEventListener('loadedmetadata', () => {
  if ('mediaSession' in navigator) { try { navigator.mediaSession.setPositionState({ duration: audio.duration || 0, position: 0 }); } catch {} }
});

/* ---------------- Media Session (Lockscreen) ---------------- */
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const s = currentSong();
  if (!s) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title || 'Unbekannt', artist: s.artist || '', album: s.album || '',
      artwork: [{ src: artUrl(s), sizes: '512x512', type: s.artwork ? s.artwork.type : 'image/png' }],
    });
  } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('previoustrack', () => prev());
  ms.setActionHandler('nexttrack', () => next(false));
  ms.setActionHandler('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

/* ================================================================
   UI
   ================================================================ */
const $ = (id) => document.getElementById(id);
const searchInput = $('search');
const songListEl = $('songList');
let filter = '';
let sortMode = localStorage.getItem('klang_sort') || 'added';

/* ---------------- Action Sheet ---------------- */
function showSheet({ title, actions }) {
  return new Promise((resolve) => {
    const titleEl = $('sheetTitle');
    titleEl.textContent = title || '';
    titleEl.style.display = title ? '' : 'none';
    $('sheetActions').innerHTML = actions.map((a) =>
      `<button class="sheet-btn${a.danger ? ' sheet-btn-danger' : ''}" data-act="${esc(a.id)}">${esc(a.label)}</button>`
    ).join('');
    $('actionSheet').classList.remove('hidden');
    function handler(e) {
      const btn = e.target.closest('[data-act]');
      const isCancel = e.target.closest('#sheetCancel');
      const isOverlay = e.target === $('actionSheet');
      if (!btn && !isCancel && !isOverlay) return;
      $('actionSheet').classList.add('hidden');
      $('actionSheet').removeEventListener('click', handler);
      resolve(btn ? btn.dataset.act : null);
    }
    $('actionSheet').addEventListener('click', handler);
  });
}

/* ---------------- Playlist Picker Sheet ---------------- */
function showPlaylistPicker(pls) {
  return new Promise((resolve) => {
    $('plPickerList').innerHTML = pls.map((p) =>
      `<button class="sheet-btn" data-plid="${p.id}">${esc(p.name)}<span style="float:right;color:var(--text-3);font-size:13px;margin-left:8px">${p.songIds.length}</span></button>`
    ).join('');
    $('plPickerSheet').classList.remove('hidden');
    function handler(e) {
      const btn = e.target.closest('[data-plid]');
      const isNew = e.target.closest('#plPickerNew');
      const isCancel = e.target.closest('#plPickerCancel');
      const isOverlay = e.target === $('plPickerSheet');
      if (!btn && !isNew && !isCancel && !isOverlay) return;
      $('plPickerSheet').classList.add('hidden');
      $('plPickerSheet').removeEventListener('click', handler);
      if (btn) resolve(Number(btn.dataset.plid));
      else if (isNew) resolve('new');
      else resolve(null);
    }
    $('plPickerSheet').addEventListener('click', handler);
  });
}

/* ---------------- Name Modal ---------------- */
function showNameModal(title, placeholder, defaultVal) {
  return new Promise((resolve) => {
    $('nameModalTitle').textContent = title;
    $('nameInput').placeholder = placeholder || '';
    $('nameInput').value = defaultVal || '';
    $('nameModal').classList.remove('hidden');
    setTimeout(() => { $('nameInput').focus(); $('nameInput').select(); }, 80);
    function finish(val) {
      $('nameModal').classList.add('hidden');
      $('nameConfirm').onclick = null; $('nameCancel').onclick = null; $('nameInput').onkeydown = null;
      resolve(val);
    }
    $('nameConfirm').onclick = () => finish($('nameInput').value.trim() || null);
    $('nameCancel').onclick = () => finish(null);
    $('nameInput').onkeydown = (e) => {
      if (e.key === 'Enter') finish($('nameInput').value.trim() || null);
      if (e.key === 'Escape') finish(null);
    };
  });
}

/* ---------------- Song-Picker (Vollbild, Mehrfachauswahl) ---------------- */
function pickSongs(title, excludeIds) {
  return new Promise((resolve) => {
    const sel = new Set();
    let pf = '';
    const candidates = library.filter((s) => !excludeIds.has(s.id));
    function draw() {
      const f = pf.toLowerCase();
      const list = candidates.filter((s) => !f || (s.title || '').toLowerCase().includes(f) || (s.artist || '').toLowerCase().includes(f));
      $('pickerEmpty').classList.toggle('hidden', candidates.length > 0);
      $('pickerList').innerHTML = list.map((s) =>
        `<li class="row${sel.has(s.id) ? ' selected' : ''}" data-id="${s.id}">
          <div class="row-check"></div>
          ${s.artwork ? `<img class="row-art" src="${artUrl(s)}" alt="" />` : '<div class="row-art placeholder">♪</div>'}
          <div class="row-meta"><div class="row-title">${esc(s.title || 'Unbekannt')}</div><div class="row-sub">${esc(s.artist || '')}</div></div>
        </li>`).join('');
      $('pickerDone').textContent = sel.size ? `Fertig (${sel.size})` : 'Fertig';
    }
    $('pickerTitle').textContent = title;
    $('pickerSearch').value = ''; pf = '';
    draw();
    $('pickerOverlay').classList.remove('hidden');
    function onList(e) { const r = e.target.closest('.row'); if (!r) return; const id = Number(r.dataset.id); if (sel.has(id)) sel.delete(id); else sel.add(id); draw(); }
    function onSearch() { pf = $('pickerSearch').value; draw(); }
    function done(val) {
      $('pickerOverlay').classList.add('hidden');
      $('pickerList').removeEventListener('click', onList);
      $('pickerSearch').removeEventListener('input', onSearch);
      $('pickerDone').onclick = null; $('pickerCancel').onclick = null;
      resolve(val);
    }
    $('pickerList').addEventListener('click', onList);
    $('pickerSearch').addEventListener('input', onSearch);
    $('pickerDone').onclick = () => done(Array.from(sel));
    $('pickerCancel').onclick = () => done(null);
  });
}

/* ---------------- Playlist-Operationen ---------------- */
async function addSongsToPlaylist(songIds) {
  const pls = await dbAllPlaylists();
  let targetId;
  if (!pls.length) {
    const name = await showNameModal('Neue Playlist', 'Playlist-Name', '');
    if (!name) return;
    targetId = await dbAddPlaylist({ name, songIds: [], dateCreated: Date.now() });
  } else {
    const picked = await showPlaylistPicker(pls);
    if (picked === null) return;
    if (picked === 'new') {
      const name = await showNameModal('Neue Playlist', 'Playlist-Name', '');
      if (!name) return;
      targetId = await dbAddPlaylist({ name, songIds: [], dateCreated: Date.now() });
    } else { targetId = picked; }
  }
  const target = await dbGetPlaylist(targetId);
  if (!target) return;
  let added = 0;
  for (const id of songIds) { if (!target.songIds.includes(id)) { target.songIds.push(id); added++; } }
  await dbPutPlaylist(target);
  renderPlaylists();
  toast(added > 0 ? `${added} Song${plural(added)} zu „${target.name}“ hinzugefügt` : `Bereits in „${target.name}“`);
}

async function confirmDeleteSongs(songIds) {
  const count = songIds.length;
  const firstName = count === 1 ? (library.find((s) => s.id === songIds[0])?.title || 'Song') : null;
  const sheetTitle = count === 1 ? `„${firstName}“ löschen?` : `${count} Songs löschen?`;
  const btnLabel = count === 1 ? 'Song löschen' : `${count} Songs löschen`;
  const action = await showSheet({ title: sheetTitle, actions: [{ label: btnLabel, id: 'confirm', danger: true }] });
  if (action === 'confirm') {
    for (const id of songIds) await deleteSongEverywhere(id);
    toast(count === 1 ? 'Song gelöscht' : `${count} Songs gelöscht`);
  }
}

async function deleteSongEverywhere(id) {
  await dbDeleteSong(id);
  dropArt(id);
  const pls = await dbAllPlaylists();
  for (const p of pls) {
    const n = p.songIds.filter((x) => x !== id);
    if (n.length !== p.songIds.length) { p.songIds = n; await dbPutPlaylist(p); }
  }
  if (currentSong() && currentSong().id === id) {
    audio.pause(); audio.src = '';
    queue = queue.filter((s) => s.id !== id);
    qIndex = Math.min(qIndex, queue.length - 1);
    if (queue.length === 0) closeNowPlaying();
    updatePlayerUI();
  } else {
    queue = queue.filter((s) => s.id !== id);
  }
  await refreshLibrary();
}

/* ---------------- Favoriten ---------------- */
async function toggleFavorite(id) {
  const rec = await dbGetSong(id);
  if (!rec) return false;
  rec.favorite = !rec.favorite;
  await dbPutSong(rec);
  const lib = library.find((s) => s.id === id); if (lib) lib.favorite = rec.favorite;
  const q = queue.find((s) => s.id === id); if (q) q.favorite = rec.favorite;
  return rec.favorite;
}

/* ---------------- Multi-Select ---------------- */
let selectMode = false;
const selectedIds = new Set();

function enterSelectMode() {
  selectMode = true;
  document.body.classList.add('select-mode');
  selectedIds.clear();
  $('selectBtn').textContent = 'Fertig';
  $('selectBtn').classList.add('active');
  $('selectionBar').classList.remove('hidden');
  updateSelectionBar();
  renderSongList();
}
function exitSelectMode() {
  selectMode = false;
  document.body.classList.remove('select-mode');
  selectedIds.clear();
  $('selectBtn').textContent = '☑ Auswählen';
  $('selectBtn').classList.remove('active');
  $('selectionBar').classList.add('hidden');
  renderSongList();
  updatePlayerUI();
}
function updateSelectionBar() {
  const count = selectedIds.size;
  $('selCount').textContent = count === 0 ? 'Tippe zum Auswählen' : count + ' ausgewählt';
  $('selAddPlaylist').disabled = count === 0;
  $('selDelete').disabled = count === 0;
  const vis = visibleLibrary();
  const allSel = vis.length > 0 && vis.every((s) => selectedIds.has(s.id));
  $('selAll').textContent = allSel ? 'Keine' : 'Alle';
}

/* ---------------- Song-Liste ---------------- */
function visibleLibrary() {
  if (!filter) return library;
  const f = filter.toLowerCase();
  return library.filter((s) => (s.title || '').toLowerCase().includes(f) || (s.artist || '').toLowerCase().includes(f));
}

function rowHtml(song, idx) {
  const playing = !selectMode && currentSong() && currentSong().id === song.id;
  const selected = selectMode && selectedIds.has(song.id);
  const art = song.artwork ? `<img class="row-art" src="${artUrl(song)}" alt="" />` : `<div class="row-art placeholder">♪</div>`;
  const left = selectMode ? `<div class="row-check"></div>` : '';
  const fav = song.favorite ? '<span class="row-fav">❤</span>' : '';
  const right = selectMode ? '' : `<button class="row-menu" data-menu="${song.id}">⋯</button>`;
  return `<li class="row${playing ? ' playing' : ''}${selected ? ' selected' : ''}" data-idx="${idx}" data-id="${song.id}">
    ${left}${art}
    <div class="row-meta">
      <div class="row-title">${esc(song.title || 'Unbekannt')}${fav}</div>
      <div class="row-sub">${esc(song.artist || 'Unbekannter Künstler')}</div>
    </div>
    ${right}
  </li>`;
}

function renderSongList() {
  const vis = visibleLibrary();
  $('emptyLib').classList.toggle('hidden', library.length > 0);
  songListEl.innerHTML = vis.map((s, i) => rowHtml(s, i)).join('');
}

songListEl.addEventListener('click', (e) => {
  if (selectMode) {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    updateSelectionBar();
    renderSongList();
    return;
  }
  const menu = e.target.closest('[data-menu]');
  if (menu) { openSongMenu(Number(menu.dataset.menu)); return; }
  const row = e.target.closest('.row');
  if (!row) return;
  playQueue(visibleLibrary(), Number(row.dataset.idx));
  openNowPlaying();
});

/* Langer Druck aktiviert Multi-Select */
let _longPressTimer = null;
songListEl.addEventListener('pointerdown', (e) => {
  if (selectMode) return;
  const row = e.target.closest('.row');
  if (!row) return;
  _longPressTimer = setTimeout(() => {
    enterSelectMode();
    selectedIds.add(Number(row.dataset.id));
    updateSelectionBar();
    renderSongList();
    if (navigator.vibrate) navigator.vibrate(30);
  }, 500);
});
['pointerup', 'pointermove', 'pointercancel'].forEach((ev) =>
  songListEl.addEventListener(ev, () => clearTimeout(_longPressTimer)));

/* Song-Menü (einzelner Song) */
async function openSongMenu(songId) {
  const song = library.find((s) => s.id === songId);
  if (!song) return;
  const action = await showSheet({
    title: song.title || 'Unbekannt',
    actions: [
      { label: '▶  Als Nächstes spielen', id: 'next' },
      { label: '📂  Zur Playlist hinzufügen', id: 'playlist' },
      { label: song.favorite ? '💔  Aus Favoriten entfernen' : '❤️  Zu Favoriten', id: 'fav' },
      { label: '🗑  Löschen', id: 'delete', danger: true },
    ],
  });
  if (action === 'next') playNext([songId]);
  else if (action === 'playlist') await addSongsToPlaylist([songId]);
  else if (action === 'fav') {
    const now = await toggleFavorite(songId);
    renderSongList(); renderPlaylists();
    if (currentSong() && currentSong().id === songId) updateFavBtn();
    toast(now ? 'Zu Favoriten' : 'Aus Favoriten');
  } else if (action === 'delete') await confirmDeleteSongs([songId]);
}

/* Selection Bar */
$('selectBtn').addEventListener('click', () => { if (selectMode) exitSelectMode(); else enterSelectMode(); });
$('selCancel').addEventListener('click', exitSelectMode);
$('selAll').addEventListener('click', () => {
  const vis = visibleLibrary();
  const allSel = vis.length > 0 && vis.every((s) => selectedIds.has(s.id));
  if (allSel) selectedIds.clear();
  else vis.forEach((s) => selectedIds.add(s.id));
  updateSelectionBar();
  renderSongList();
});
$('selAddPlaylist').addEventListener('click', async () => {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  exitSelectMode();
  await addSongsToPlaylist(ids);
});
$('selDelete').addEventListener('click', async () => {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  exitSelectMode();
  await confirmDeleteSongs(ids);
});

/* ---------------- Sortieren ---------------- */
function sortLibrary(arr) {
  const a = arr.slice();
  if (sortMode === 'title') a.sort((x, y) => (x.title || '').localeCompare(y.title || '', 'de'));
  else if (sortMode === 'artist') a.sort((x, y) => (x.artist || '~').localeCompare(y.artist || '~', 'de') || (x.title || '').localeCompare(y.title || '', 'de'));
  else a.sort((x, y) => (y.dateAdded || 0) - (x.dateAdded || 0));
  return a;
}
$('sortBtn').addEventListener('click', async () => {
  const mark = (m) => (sortMode === m ? '✓  ' : '');
  const a = await showSheet({
    title: 'Sortieren nach',
    actions: [
      { label: mark('added') + 'Zuletzt hinzugefügt', id: 'added' },
      { label: mark('title') + 'Titel (A–Z)', id: 'title' },
      { label: mark('artist') + 'Künstler (A–Z)', id: 'artist' },
    ],
  });
  if (a) { sortMode = a; localStorage.setItem('klang_sort', a); await refreshLibrary(); }
});

/* ---------------- Now-Playing / Mini-Player ---------------- */
function updatePlayerUI() {
  const s = currentSong();
  const mini = $('miniPlayer');
  if (!s || selectMode) { mini.classList.add('hidden'); return; }
  mini.classList.remove('hidden');
  $('miniArt').src = artUrl(s);
  $('miniTitle').textContent = s.title || 'Unbekannt';
  $('miniArtist').textContent = s.artist || '';
  $('npArt').src = artUrl(s);
  $('npTitle').textContent = s.title || 'Unbekannt';
  $('npArtist').textContent = s.artist || 'Unbekannter Künstler';
  updateFavBtn();
  updatePlayPauseIcons();
}

function updateFavBtn() {
  const s = currentSong();
  const b = $('favBtn');
  if (!b) return;
  const on = !!(s && s.favorite);
  b.textContent = on ? '❤' : '♡';
  b.classList.toggle('on', on);
}

const PLAY_SVG = '<svg class="play-glyph" viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5a1 1 0 0 1 1.5-.87l11 6.5a1 1 0 0 1 0 1.74l-11 6.5A1 1 0 0 1 8 18V5Z"/></svg>';
const PAUSE_SVG = '<svg class="play-glyph" viewBox="0 0 24 24" width="24" height="24"><rect fill="currentColor" x="6" y="5" width="4" height="14" rx="1.3"/><rect fill="currentColor" x="14" y="5" width="4" height="14" rx="1.3"/></svg>';
function updatePlayPauseIcons() {
  const playing = !audio.paused;
  $('playBtn').innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  $('miniPlay').innerHTML = playing
    ? '<svg viewBox="0 0 24 24" width="22" height="22"><rect fill="currentColor" x="6" y="5" width="4" height="14" rx="1.3"/><rect fill="currentColor" x="14" y="5" width="4" height="14" rx="1.3"/></svg>'
    : '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M8 5a1 1 0 0 1 1.5-.87l11 6.5a1 1 0 0 1 0 1.74l-11 6.5A1 1 0 0 1 8 18V5Z"/></svg>';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function openNowPlaying() { $('nowPlaying').classList.remove('hidden'); }
function closeNowPlaying() { $('nowPlaying').classList.add('hidden'); }

$('favBtn').addEventListener('click', async () => {
  const s = currentSong();
  if (!s) return;
  const now = await toggleFavorite(s.id);
  updateFavBtn();
  renderSongList();
  renderPlaylists();
  if (_detailMode === 'fav' && !$('playlistDetail').classList.contains('hidden')) openFavorites();
  toast(now ? 'Zu Favoriten' : 'Aus Favoriten');
});

/* Swipe-down zum Schließen des Now-Playing */
let _npSwipeStart = null;
$('nowPlaying').addEventListener('touchstart', (e) => { _npSwipeStart = e.touches[0].clientY; }, { passive: true });
$('nowPlaying').addEventListener('touchend', (e) => {
  if (_npSwipeStart !== null && e.changedTouches[0].clientY - _npSwipeStart > 70) closeNowPlaying();
  _npSwipeStart = null;
});

/* ---------------- Seek ---------------- */
let seeking = false;
const seekEl = $('seek');
seekEl.addEventListener('input', () => { seeking = true; });
seekEl.addEventListener('change', () => {
  const d = audio.duration || 0;
  if (d > 0) audio.currentTime = (Number(seekEl.value) / 1000) * d;
  seeking = false;
});

/* ---------------- Playlists-Ansicht ---------------- */
function playlistCover(p) {
  const arts = p.songIds.map((id) => library.find((s) => s.id === id)).filter((s) => s && s.artwork);
  if (arts.length >= 4) return `<div class="pl-cover grid-4">${arts.slice(0, 4).map((s) => `<img src="${artUrl(s)}" alt="" />`).join('')}</div>`;
  if (arts.length >= 1) return `<div class="pl-cover single"><img src="${artUrl(arts[0])}" alt="" /></div>`;
  return `<div class="pl-cover">📂</div>`;
}

async function renderPlaylists() {
  const pls = await dbAllPlaylists();
  const favCount = library.filter((s) => s.favorite).length;
  $('emptyPl').classList.toggle('hidden', pls.length > 0);
  let html = `<li class="row" data-fav="1">
    <div class="pl-cover fav">❤</div>
    <div class="row-meta"><div class="row-title">Favoriten</div><div class="row-sub">${favCount} Song${plural(favCount)}</div></div>
    <div class="row-menu" style="opacity:0">⋯</div>
  </li>`;
  html += pls.map((p) => `
    <li class="row" data-pl="${p.id}">
      ${playlistCover(p)}
      <div class="row-meta">
        <div class="row-title">${esc(p.name)}</div>
        <div class="row-sub">${p.songIds.length} Song${plural(p.songIds.length)}</div>
      </div>
      <button class="row-menu" data-plmenu="${p.id}">⋯</button>
    </li>`).join('');
  $('playlistList').innerHTML = html;
}

$('playlistList').addEventListener('click', async (e) => {
  const favRow = e.target.closest('[data-fav]');
  if (favRow) { openFavorites(); return; }
  const menuBtn = e.target.closest('[data-plmenu]');
  if (menuBtn) {
    const id = Number(menuBtn.dataset.plmenu);
    const p = await dbGetPlaylist(id);
    if (!p) return;
    const action = await showSheet({
      title: p.name,
      actions: [
        { label: '✏️  Umbenennen', id: 'rename' },
        { label: '⬆️  Exportieren (.zip)', id: 'export' },
        { label: '🗑  Playlist löschen', id: 'delete', danger: true },
      ],
    });
    if (action === 'rename') {
      const name = await showNameModal('Playlist umbenennen', '', p.name);
      if (name) { p.name = name; await dbPutPlaylist(p); renderPlaylists(); toast('Umbenannt'); }
    } else if (action === 'export') {
      await exportPlaylist(p);
    } else if (action === 'delete') {
      const confirm = await showSheet({ title: `„${p.name}“ löschen?`, actions: [{ label: 'Playlist löschen', id: 'ok', danger: true }] });
      if (confirm === 'ok') { await dbDeletePlaylist(id); renderPlaylists(); toast('Playlist gelöscht'); }
    }
    return;
  }
  const row = e.target.closest('[data-pl]');
  if (row) openPlaylistDetail(Number(row.dataset.pl));
});

/* ---------------- Detail-Ansicht (Playlist + Favoriten) ---------------- */
let _detailMode = 'playlist';
let _detailPlId = null;
let _detailSongs = [];

function renderDetail(title, songs, mode, plId) {
  _detailMode = mode; _detailPlId = plId; _detailSongs = songs;
  $('plName').textContent = title;
  $('emptyPlDetail').classList.toggle('hidden', songs.length > 0);
  $('plAddSongs').classList.toggle('hidden', mode !== 'playlist');
  $('plSongs').innerHTML = songs.map((s, i) => `
    <li class="row" data-plidx="${i}" data-songid="${s.id}">
      ${s.artwork ? `<img class="row-art" src="${artUrl(s)}" alt="" />` : '<div class="row-art placeholder">♪</div>'}
      <div class="row-meta">
        <div class="row-title">${esc(s.title || 'Unbekannt')}${s.favorite ? '<span class="row-fav">❤</span>' : ''}</div>
        <div class="row-sub">${esc(s.artist || '')}</div>
      </div>
      <button class="row-menu" data-detmenu="${s.id}">⋯</button>
    </li>`).join('');
  showView('playlistDetail');
  $('viewTitle').textContent = title;
}

async function openPlaylistDetail(id) {
  const p = await dbGetPlaylist(id);
  if (!p) return;
  const songs = p.songIds.map((sid) => library.find((s) => s.id === sid)).filter(Boolean);
  renderDetail(p.name, songs, 'playlist', id);
}
function openFavorites() {
  const songs = library.filter((s) => s.favorite);
  renderDetail('Favoriten', songs, 'fav', null);
}

async function detailRowMenu(sid) {
  const song = _detailSongs.find((s) => s.id === sid) || library.find((s) => s.id === sid);
  if (_detailMode === 'fav') {
    const a = await showSheet({ title: song?.title || 'Song', actions: [
      { label: '▶  Als Nächstes spielen', id: 'next' },
      { label: '📂  Zur Playlist hinzufügen', id: 'playlist' },
      { label: '💔  Aus Favoriten entfernen', id: 'unfav' },
    ]});
    if (a === 'next') playNext([sid]);
    else if (a === 'playlist') await addSongsToPlaylist([sid]);
    else if (a === 'unfav') { await toggleFavorite(sid); renderSongList(); renderPlaylists(); openFavorites(); if (currentSong() && currentSong().id === sid) updateFavBtn(); }
  } else {
    const a = await showSheet({ title: song?.title || 'Song', actions: [
      { label: '▶  Als Nächstes spielen', id: 'next' },
      { label: '↩  Aus Playlist entfernen', id: 'remove' },
    ]});
    if (a === 'next') playNext([sid]);
    else if (a === 'remove') {
      const p = await dbGetPlaylist(_detailPlId);
      if (p) { p.songIds = p.songIds.filter((x) => x !== sid); await dbPutPlaylist(p); }
      await openPlaylistDetail(_detailPlId);
      renderPlaylists();
      toast('Aus Playlist entfernt');
    }
  }
}

$('plSongs').addEventListener('click', async (e) => {
  const menu = e.target.closest('[data-detmenu]');
  if (menu) { await detailRowMenu(Number(menu.dataset.detmenu)); return; }
  const r = e.target.closest('[data-plidx]');
  if (r) { playQueue(_detailSongs, Number(r.dataset.plidx)); openNowPlaying(); }
});
$('plPlayAll').addEventListener('click', () => { if (_detailSongs.length) { playQueue(_detailSongs, 0, false); openNowPlaying(); } });
$('plShuffle').addEventListener('click', () => { if (_detailSongs.length) { playQueue(_detailSongs, null, true); openNowPlaying(); } });
$('plAddSongs').addEventListener('click', async () => {
  if (_detailMode !== 'playlist') return;
  const p = await dbGetPlaylist(_detailPlId);
  if (!p) return;
  const picked = await pickSongs('Songs hinzufügen', new Set(p.songIds));
  if (picked && picked.length) {
    p.songIds.push(...picked);
    await dbPutPlaylist(p);
    await openPlaylistDetail(_detailPlId);
    renderPlaylists();
    toast(`${picked.length} Song${plural(picked.length)} hinzugefügt`);
  }
});

/* ---------------- Ansichten umschalten ---------------- */
function showView(name) {
  for (const v of ['libraryView', 'playlistsView', 'playlistDetail']) $(v).classList.toggle('hidden', v !== name);
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  if (selectMode) exitSelectMode();
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  const v = t.dataset.view;
  if (v === 'library') { showView('libraryView'); $('viewTitle').textContent = 'Bibliothek'; renderSongList(); }
  else { showView('playlistsView'); $('viewTitle').textContent = 'Playlists'; renderPlaylists(); }
}));
$('plBack').addEventListener('click', () => { document.querySelector('.tab[data-view="playlists"]').click(); });

/* ---------------- Buttons ---------------- */
$('importBtn').addEventListener('click', () => $('fileInput').click());
$('emptyImport').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });

$('importPlBtn').addEventListener('click', () => $('plImportInput').click());
$('plImportInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importPlaylistZip(f); e.target.value = ''; });

$('playAllBtn').addEventListener('click', () => { const v = visibleLibrary(); if (v.length) { playQueue(v, 0, false); openNowPlaying(); } });
$('shuffleAllBtn').addEventListener('click', () => { const v = visibleLibrary(); if (v.length) { playQueue(v, null, true); openNowPlaying(); } });

$('miniPlayer').addEventListener('click', (e) => { if (e.target.closest('#miniPlay') || e.target.closest('#miniNext')) return; openNowPlaying(); });
$('miniPlay').addEventListener('click', togglePlay);
$('miniNext').addEventListener('click', () => next(false));
$('npClose').addEventListener('click', closeNowPlaying);
$('playBtn').addEventListener('click', togglePlay);
$('prevBtn').addEventListener('click', prev);
$('nextBtn').addEventListener('click', () => next(false));

$('shuffleBtn').addEventListener('click', () => {
  shuffle = !shuffle; updateShuffleIcon();
  const cur = currentSong();
  if (!baseQueue.length) return;
  if (shuffle) {
    // einschalten: aktuellen Song behalten, Rest mischen
    queue = cur ? [cur, ...shuffleArr(baseQueue.filter((s) => s !== cur))] : shuffleArr(baseQueue);
    qIndex = 0;
  } else {
    // ausschalten: Originalreihenfolge wiederherstellen, an aktueller Stelle weiter
    queue = baseQueue.slice();
    qIndex = cur ? Math.max(0, queue.indexOf(cur)) : 0;
  }
});
$('repeatBtn').addEventListener('click', () => {
  repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
  audio.loop = (repeat === 'one');
  renderRepeatBtn();
});
function renderRepeatBtn() {
  $('repeatBtn').textContent = repeat === 'one' ? '🔂' : '↻';
  $('repeatBtn').classList.toggle('on', repeat !== 'off');
}
function updateShuffleIcon() { $('shuffleBtn').classList.toggle('on', shuffle); }

/* Neue Playlist – direkt Songs auswählen */
$('newPlaylistBtn').addEventListener('click', async () => {
  const name = await showNameModal('Neue Playlist', 'Playlist-Name', '');
  if (!name) return;
  const picked = await pickSongs(`Songs zu „${name}“`, new Set());
  const ids = picked ? [...new Set(picked)] : [];
  const plId = await dbAddPlaylist({ name, songIds: ids, dateCreated: Date.now() });
  renderPlaylists();
  toast(ids.length ? `„${name}“ mit ${ids.length} Song${plural(ids.length)} erstellt` : `„${name}“ erstellt`);
  openPlaylistDetail(plId);
});

searchInput.addEventListener('input', () => { filter = searchInput.value; renderSongList(); });

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------------- Daten laden ---------------- */
async function refreshLibrary() {
  library = sortLibrary(await dbAllSongs());
  $('libCount').textContent = library.length ? `${library.length} Song${plural(library.length)}` : '';
  renderSongList();
}

/* ---------------- Start ---------------- */
async function main() {
  _db = await openDB();
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch {} }
  await refreshLibrary();
  updatePlayPauseIcons();
  renderRepeatBtn();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('./sw.js'); } catch {} }
}
main().catch((e) => toast('Startfehler: ' + e.message, true));
