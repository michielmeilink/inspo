/* inspo — dashboard voor opgeslagen Instagram-posts.
 * Data staat versleuteld (AES-256-GCM, sleutel via PBKDF2 uit je wachtwoord) in data.enc.
 * Opslaan gaat via de GitHub Contents API met een fine-grained token dat alleen in deze browser staat.
 */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const DATA_FILE = 'data.enc';
const DEFAULT_GH = { owner: 'michielmeilink', repo: 'inspo', branch: 'main', token: '' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('insp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('insp.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('insp.' + k); } catch {} },
};

const state = {
  db: null, password: null, blob: null, sha: null,
  view: store.get('view', 'all'), q: '', tag: null, sort: store.get('sort', 'new'), mode: store.get('mode', 'wall'),
  list: [], openIdx: -1, saving: false, again: false,
};

/* ---------- Crypto ---------- */
const te = new TextEncoder(), td = new TextDecoder();
function b64(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
async function deriveKey(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptDb(obj, pw) {
  const iter = 310000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt, iter);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}
async function decryptDb(text, pw) {
  const o = JSON.parse(text);
  const key = await deriveKey(pw, unb64(o.salt), o.iter || 310000);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.ct));
  return JSON.parse(td.decode(pt));
}

/* ---------- GitHub ---------- */
const gh = () => store.get('gh', null);
const ghOk = () => { const c = gh(); return !!(c && c.owner && c.repo && c.token); };
function ghUrl(c, path = DATA_FILE) { return `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/contents/${path}`; }
function ghHeaders(c, accept = 'application/vnd.github+json') {
  return { Authorization: `Bearer ${c.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}
async function ghGet() {
  const c = gh();
  const r = await fetch(`${ghUrl(c)}?ref=${encodeURIComponent(c.branch || 'main')}&t=${Date.now()}`, { headers: ghHeaders(c), cache: 'no-store' });
  if (r.status === 404) { state.sha = null; return null; }
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  state.sha = j.sha;
  if (j.content) return td.decode(unb64(j.content));
  // Bestanden > 1 MB: inhoud apart ophalen
  const raw = await fetch(`${ghUrl(c)}?ref=${encodeURIComponent(c.branch || 'main')}`, { headers: ghHeaders(c, 'application/vnd.github.raw+json'), cache: 'no-store' });
  if (!raw.ok) throw new Error(`GitHub ${raw.status}`);
  return raw.text();
}
async function ghPut(text) {
  const c = gh();
  const body = { message: `Update inspiratie (${new Date().toISOString().slice(0, 16)})`, content: b64(te.encode(text)), branch: c.branch || 'main' };
  if (state.sha) body.sha = state.sha;
  const r = await fetch(ghUrl(c), { method: 'PUT', headers: { ...ghHeaders(c), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) { const e = new Error('conflict'); e.conflict = true; throw e; }
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  state.sha = j.content.sha;
}
async function ghTest(c) {
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`, { headers: ghHeaders(c), cache: 'no-store' });
  if (r.status === 404) return { ok: false, msg: 'Repo niet gevonden, of het token heeft geen toegang tot deze repo.' };
  if (r.status === 401) return { ok: false, msg: 'Token ongeldig of verlopen.' };
  if (!r.ok) return { ok: false, msg: `GitHub gaf status ${r.status}.` };
  const j = await r.json();
  if (j.permissions && !j.permissions.push) return { ok: false, msg: 'Token mag lezen maar niet schrijven. Zet Contents op "Read and write".' };
  return { ok: true, msg: `Gekoppeld aan ${j.full_name}${j.private ? ' (privé)' : ''}.` };
}

/* ---------- Data ---------- */
const emptyDb = () => ({ v: 1, posts: {}, collections: [], updatedAt: Date.now() });

function fixText(s) {
  // Instagram-exports bevatten UTF-8 als latin-1 (Ã©). Herstel waar mogelijk.
  if (typeof s !== 'string') return s;
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}
function normType(t) { return t === 'reels' ? 'reel' : t; }

function addPost(db, it) {
  if (!it.code) return false;
  let p = db.posts[it.code];
  const isNew = !p;
  if (!p) {
    p = db.posts[it.code] = { code: it.code, type: it.type || 'p', owner: '', savedAt: 0, collections: [], tags: [], note: '', caption: '', thumb: '', hidden: false, addedAt: Date.now(), editedAt: 0 };
  }
  if (it.type && (p.type === 'p' || !p.type) && it.type !== 'p') p.type = it.type;
  if (it.owner && !p.owner) p.owner = it.owner;
  if (it.savedAt && (!p.savedAt || it.savedAt > p.savedAt)) p.savedAt = it.savedAt;
  if (it.caption && it.caption !== p.caption) p.caption = it.caption;
  if (it.thumb) p.thumb = it.thumb;
  if (it.collection) {
    if (!p.collections.includes(it.collection)) p.collections.push(it.collection);
    if (!db.collections.includes(it.collection)) db.collections.push(it.collection);
  }
  return isNew;
}

function mergeDb(local, remote) { return mergeInto(JSON.parse(JSON.stringify(local)), remote); }
function mergeInto(out, remote) {
  if (!out.tk && remote.tk) out.tk = remote.tk;
  if ((remote.syncedAt || 0) > (out.syncedAt || 0)) out.syncedAt = remote.syncedAt;
  for (const c of remote.collections || []) if (!out.collections.includes(c)) out.collections.push(c);
  for (const [code, rp] of Object.entries(remote.posts || {})) {
    const lp = out.posts[code];
    if (!lp) { out.posts[code] = rp; continue; }
    for (const c of rp.collections || []) if (!lp.collections.includes(c)) lp.collections.push(c);
    for (const k of ['owner', 'caption', 'thumb', 'w', 'h', 'dur', 'mt', 'takenAt']) if (!lp[k] && rp[k]) lp[k] = rp[k];
    if ((rp.savedAt || 0) > (lp.savedAt || 0)) lp.savedAt = rp.savedAt;
    if ((rp.editedAt || 0) > (lp.editedAt || 0)) {
      lp.tags = rp.tags || []; lp.note = rp.note || ''; lp.hidden = !!rp.hidden; lp.editedAt = rp.editedAt;
    }
  }
  return out;
}

/* ---------- Instagram-export parser ---------- */
const POST_RE = /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;
const COLL_TITLE = /^(collection|collectie|verzameling)$/i;
const NAME_KEY = /^(name|naam)$/i;
const OWNER_LABEL = /(user|gebruiker|owner|account|author|auteur)/i;

function walk(o, fn, path = []) {
  if (o && typeof o === 'object') {
    fn(o, path);
    for (const k of Object.keys(o)) walk(o[k], fn, [...path, k]);
  }
}
function strings(o) {
  const out = [];
  (function rec(x, path) {
    if (typeof x === 'string') out.push({ path, v: x });
    else if (x && typeof x === 'object') for (const k of Object.keys(x)) rec(x[k], [...path, k]);
  })(o, []);
  return out;
}
function postMatches(entry) {
  const seen = new Map();
  for (const s of strings(entry)) {
    const m = s.v.match(POST_RE);
    if (m && !seen.has(m[2])) seen.set(m[2], { code: m[2], type: normType(m[1]) });
  }
  return [...seen.values()];
}
function maxTimestamp(entry) {
  let t = 0;
  walk(entry, (o) => {
    for (const [k, v] of Object.entries(o)) if (/timestamp|time/i.test(k) && typeof v === 'number' && v > t) t = v;
  });
  if (!t && typeof entry.timestamp === 'number') t = entry.timestamp;
  return t ? (t < 1e12 ? t * 1000 : t) : 0;
}
function ownerOf(entry) {
  if (typeof entry.title === 'string' && entry.title && !COLL_TITLE.test(entry.title) && !POST_RE.test(entry.title)) return fixText(entry.title);
  let found = '';
  walk(entry, (o) => {
    if (found) return;
    if (typeof o.label === 'string' && OWNER_LABEL.test(o.label) && typeof o.value === 'string' && !/^https?:/.test(o.value)) found = o.value;
  });
  if (found) return fixText(found);
  for (const s of strings(entry)) {
    const keyPath = s.path.join('.');
    if (/name|naam/i.test(keyPath) && !/^https?:/.test(s.v) && s.v.length < 40) return fixText(s.v);
  }
  return '';
}
function captionOf(entry) {
  let found = '';
  walk(entry, (o) => {
    if (found) return;
    if (typeof o.label === 'string' && /^(caption|onderschrift|bijschrift)$/i.test(o.label) && typeof o.value === 'string') found = o.value;
  });
  return fixText(found).trim();
}
function collectionName(entry) {
  let found = '';
  walk(entry, (o, path) => {
    if (found) return;
    const last = path[path.length - 1];
    if (typeof last === 'string' && NAME_KEY.test(last) && typeof o.value === 'string') found = o.value;
    else if (typeof o.label === 'string' && NAME_KEY.test(o.label) && typeof o.value === 'string') found = o.value;
  });
  if (!found) {
    const s = strings(entry).find(x => !/^https?:/.test(x.v) && !COLL_TITLE.test(x.v) && x.v.length < 80);
    found = s ? s.v : '';
  }
  return fixText(found).trim();
}
function isCollectionHeader(entry) {
  return (typeof entry.title === 'string' && COLL_TITLE.test(entry.title)) ||
    strings(entry).some(s => s.path[s.path.length - 1] === 'label' && COLL_TITLE.test(s.v));
}
function topArrays(json) {
  if (Array.isArray(json)) return [json];
  return Object.values(json || {}).filter(Array.isArray);
}
function parseExport(files) {
  const items = [];
  for (const f of files) {
    const isColl = /collection/i.test(f.name) || Object.keys(f.json || {}).some(k => /collection/i.test(k));
    for (const arr of topArrays(f.json)) {
      let current = null;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        const posts = postMatches(entry);
        const header = isColl && (isCollectionHeader(entry) || posts.length === 0 || posts.length > 1);
        if (header) {
          const name = collectionName(entry);
          if (name) current = name;
          // Collectie met geneste posts (nieuwer exportformaat)
          for (const p of posts) items.push({ ...p, collection: current, savedAt: 0 });
          continue;
        }
        for (const p of posts) {
          items.push({ ...p, owner: ownerOf(entry), caption: captionOf(entry), savedAt: maxTimestamp(entry), collection: isColl ? current : null });
        }
      }
    }
  }
  return items;
}

async function readFiles(fileList) {
  const jsons = [];
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f);
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir || !/\.json$/i.test(path) || !/saved/i.test(path)) continue;
        try { jsons.push({ name: path, json: JSON.parse(await entry.async('string')) }); } catch {}
      }
    } else if (/\.json$/i.test(f.name)) {
      try {
        const json = JSON.parse(await f.text());
        // Eigen back-up terugzetten
        if (json && json.posts && json.collections && !Array.isArray(json.posts)) { jsons.push({ name: f.name, backup: json }); continue; }
        jsons.push({ name: f.name, json });
      } catch { toast(`${f.name} is geen geldige JSON.`); }
    }
  }
  return jsons;
}

async function importFiles(fileList) {
  if (!state.db) return;
  const files = await readFiles(fileList);
  if (!files.length) { toast('Geen saved_*.json gevonden. Kies bij de export het formaat JSON, niet HTML.'); return; }
  const before = Object.keys(state.db.posts).length;
  for (const f of files.filter(f => f.backup)) state.db = mergeDb(state.db, f.backup);
  const items = parseExport(files.filter(f => f.json));
  for (const it of items) addPost(state.db, it);
  const added = Object.keys(state.db.posts).length - before;
  toast(`${added} nieuwe posts toegevoegd (${items.length} verwerkt).`);
  render();
  markDirty();
}

/* ---------- Opslaan ---------- */
let saveTimer = null;
function setStatus(text, cls = '') { const el = $('#status'); el.textContent = text; el.className = 'status ' + cls; }
function markDirty() { setStatus('niet opgeslagen', 'warn'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200); }
window.addEventListener('beforeunload', (e) => { if (saveTimer || state.saving) { e.preventDefault(); e.returnValue = ''; } });

async function save() {
  saveTimer = null;
  if (state.saving) { state.again = true; return; }
  state.saving = true;
  setStatus('opslaan…');
  try {
    state.db.updatedAt = Date.now();
    let blob = await encryptDb(state.db, state.password);
    store.set('cache', blob);
    if (ghOk()) {
      await ghLocked(async () => {
        try { await ghPut(blob); }
        catch (e) {
          if (!e.conflict) throw e;
          // Remote is intussen gewijzigd (ander apparaat of sync): samenvoegen en opnieuw proberen
          const remote = await ghGet();
          if (remote) mergeInto(state.db, await decryptDb(remote, state.password));
          blob = await encryptDb(state.db, state.password);
          store.set('cache', blob);
          await ghPut(blob);
        }
      });
      if (!sync.running) setStatus('opgeslagen', 'ok');
    } else {
      setStatus('alleen in deze browser opgeslagen', 'warn');
    }
  } catch (e) {
    setStatus('opslaan mislukt: ' + e.message, 'err');
  }
  state.saving = false;
  if (state.again) { state.again = false; save(); }
}

/* ---------- Laden + ontgrendelen ---------- */
async function loadBlob() {
  let blob = null, err = null;
  try {
    if (ghOk()) blob = await ghGet();
    else {
      const r = await fetch(DATA_FILE + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) blob = await r.text();
    }
  } catch (e) { err = e; }
  if (!blob) blob = store.get('cache', null);
  state.blob = blob;
  return err;
}

function showLock(msg = '') {
  document.body.classList.add('locked');
  $('#app').hidden = true;
  $('#lock').hidden = false;
  const isNew = !state.blob;
  $('#lockIntro').textContent = isNew
    ? 'Nog geen data gevonden. Kies een wachtwoord om je dashboard te versleutelen.'
    : 'Voer je wachtwoord in.';
  $('#pw2').hidden = !isNew;
  $('#pw2').required = isNew;
  $('#pw').autocomplete = isNew ? 'new-password' : 'current-password';
  $('#lockBtn').textContent = isNew ? 'Maak dashboard' : 'Ontgrendel';
  lockMsg(msg, msg ? 'err' : '');
  setTimeout(() => $('#pw').focus(), 50);
}
function lockMsg(t, cls = '') { const el = $('#lockMsg'); el.textContent = t; el.className = 'msg ' + cls; }

async function unlock(pw, remember) {
  lockMsg('Bezig…');
  if (state.blob) {
    try { state.db = await decryptDb(state.blob, pw); }
    catch { lockMsg('Verkeerd wachtwoord.', 'err'); store.del('pw'); return false; }
  } else {
    state.db = emptyDb();
  }
  state.password = pw;
  if (remember) store.set('pw', pw); else store.del('pw');
  document.body.classList.remove('locked');
  $('#lock').hidden = true;
  $('#app').hidden = false;
  render();
  if (!state.blob) save();
  else setStatus(ghOk() ? 'gesynchroniseerd' : 'niet gekoppeld aan GitHub', ghOk() ? 'ok' : 'warn');
  if (!Object.keys(state.db.posts).length) showEmptyHint();
  initNav();
  render();
  updateSyncUi();
  maybeAutoSync();
  return true;
}

/* ---------- Extensie-brug ----------
 * De inspo-extensie zet een content script op deze pagina. We praten ermee via window.postMessage. */
const ext = { ready: false, version: null, seq: 0, pending: new Map() };
function extCall(cmd, args = {}, timeout = 45000) {
  return new Promise((resolve, reject) => {
    if (!ext.ready) return reject(Object.assign(new Error('De inspo-extensie is niet gevonden.'), { code: 'noext' }));
    const id = ++ext.seq;
    const t = setTimeout(() => {
      ext.pending.delete(id);
      reject(Object.assign(new Error('De extensie reageert niet.'), { code: 'timeout' }));
    }, timeout);
    ext.pending.set(id, { resolve, reject, t });
    window.postMessage({ __inspo: 'req', id, cmd, args }, location.origin);
  });
}
window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d) return;
  if (d.__inspo === 'ready') {
    const first = !ext.ready;
    ext.ready = true; ext.version = d.version;
    if (first) { document.body.classList.add('has-ext'); updateSyncUi(); maybeAutoSync(); }
  } else if (d.__inspo === 'res') {
    const p = ext.pending.get(d.id);
    if (!p) return;
    ext.pending.delete(d.id); clearTimeout(p.t);
    if (d.ok) p.resolve(d);
    else p.reject(Object.assign(new Error(d.error || 'Fout in de extensie.'), { code: d.code }));
  }
});

/* ---------- Thumbnails (versleuteld in de repo) ----------
 * Sleutel: willekeurige 32 bytes in de (versleutelde) database, dus los van je wachtwoord.
 * Bestandsnaam: HMAC van de post-code, zodat de repo niet verraadt welke posts het zijn. */
let tkeys = null;
async function thumbKeys() {
  if (tkeys) return tkeys;
  if (!state.db.tk) state.db.tk = b64(crypto.getRandomValues(new Uint8Array(32)));
  const base = await crypto.subtle.importKey('raw', unb64(state.db.tk), 'HKDF', false, ['deriveKey']);
  const info = (s) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(s) });
  tkeys = {
    aes: await crypto.subtle.deriveKey(info('inspo-thumb-aes'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    mac: await crypto.subtle.deriveKey(info('inspo-thumb-name'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  };
  return tkeys;
}
async function thumbName(code) {
  const k = await thumbKeys();
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k.mac, te.encode(code)));
  return [...sig.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function encThumb(bytes) {
  const k = await thumbKeys();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k.aes, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}
async function decThumb(buf) {
  const k = await thumbKeys();
  const b = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, k.aes, b.subarray(12));
}
async function toJpeg(bytes, mime, maxW) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const scale = Math.min(1, maxW / bmp.width);
  const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return new Uint8Array(await blob.arrayBuffer());
}

const thumbMem = new Map();      // naam -> object-URL
const thumbPending = new Map();  // naam -> Promise
function thumbUrl(name) {
  if (thumbMem.has(name)) return Promise.resolve(thumbMem.get(name));
  if (thumbPending.has(name)) return thumbPending.get(name);
  const job = (async () => {
    const c = gh() || DEFAULT_GH;
    const branch = c.branch || 'main';
    let r = await fetch(`https://raw.githubusercontent.com/${c.owner}/${c.repo}/${branch}/thumbs/${name}.bin`);
    if (!r.ok && ghOk()) r = await fetch(`${ghUrl(c, `thumbs/${name}.bin`)}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(c, 'application/vnd.github.raw+json') });
    if (!r.ok) throw new Error('thumbnail ' + r.status);
    const plain = await decThumb(await r.arrayBuffer());
    const url = URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
    thumbMem.set(name, url);
    return url;
  })();
  thumbPending.set(name, job);
  job.finally(() => thumbPending.delete(name)).catch(() => {});
  return job;
}
const thumbIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbIO.unobserve(e.target);
    const host = e.target.closest('[data-i]');
    showThumb(e.target, host ? state.list[+host.dataset.i] : null);
  }
}, { rootMargin: '1200px 0px' });
async function showThumb(crop, p) {
  const img = crop.querySelector('img[data-thumb]');
  if (!img) return;
  try {
    img.addEventListener('load', () => img.classList.add('in'), { once: true });
    img.src = await thumbUrl(img.dataset.thumb);
  } catch {
    img.remove();
    crop.classList.remove('thumb');
    if (p) mountEmbed(crop, p);
  }
}
function refreshThumbs() {
  for (const tile of $$('#wall .tile')) {
    const p = state.list[+tile.dataset.i];
    const crop = tile.querySelector('.crop');
    if (!p || !p.thumb || crop.classList.contains('thumb')) continue;
    unmountEmbed(crop);
    crop.outerHTML = cropHtml(p);
    showThumb(tile.querySelector('.crop'), p);
  }
}

/* ---------- GitHub: meerdere bestanden in één commit ---------- */
let ghChain = Promise.resolve();
function ghLocked(fn) { const run = ghChain.then(fn, fn); ghChain = run.catch(() => {}); return run; }
async function ghJson(url, opts = {}) {
  const c = gh();
  const r = await fetch(url, { ...opts, headers: { ...ghHeaders(c), 'Content-Type': 'application/json' }, cache: 'no-store' });
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
async function ghCommitFiles(files, message) {
  const c = gh();
  const base = `https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/git`;
  const branch = c.branch || 'main';
  const tree = [];
  for (const f of files) {
    const blob = await ghJson(`${base}/blobs`, { method: 'POST', body: JSON.stringify({ content: f.b64, encoding: 'base64' }) });
    f.sha = blob.sha;
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await ghJson(`${base}/ref/heads/${branch}`);
    const head = await ghJson(`${base}/commits/${ref.object.sha}`);
    const t = await ghJson(`${base}/trees`, { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const cm = await ghJson(`${base}/commits`, { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [ref.object.sha] }) });
    try {
      await ghJson(`${base}/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: cm.sha }) });
      return;
    } catch (e) {
      if (e.status !== 422 || attempt === 2) throw e;
    }
  }
}

/* ---------- Sync met Instagram ---------- */
const sync = { running: false, stop: false };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const politePause = () => pause(1400 + Math.random() * 1600);
function typeFromMedia(m, fallback) {
  if (m.product === 'clips') return 'reel';
  if (m.product === 'igtv') return 'tv';
  return fallback || 'p';
}
function fmtDur(sec) {
  const s = Math.round(sec || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function applyMeta(p, m) {
  let changed = false;
  const set = (k, v) => { if (v && p[k] !== v) { p[k] = v; changed = true; } };
  set('w', m.w); set('h', m.h); set('dur', Math.round((m.dur || 0) * 10) / 10); set('mt', m.mt); set('takenAt', m.takenAt);
  if (!p.owner) set('owner', m.owner);
  if (!p.caption) set('caption', m.caption);
  if (m.product) set('type', typeFromMedia(m, p.type));
  if (p.gone) { p.gone = false; changed = true; }
  return changed;
}
function updateSyncUi() {
  const b = $('#btnSync');
  if (b) { b.hidden = !ext.ready || !state.db; b.textContent = sync.running ? 'stop sync' : 'sync instagram'; }
  const s = $('#xStatus');
  if (s) {
    s.textContent = ext.ready
      ? `Extensie ${ext.version} is actief in deze browser.${state.db && state.db.syncedAt ? ' Laatste sync: ' + fmtDate(state.db.syncedAt, true) + '.' : ' Nog niet gesynchroniseerd.'}`
      : 'De extensie is niet gevonden in deze browser.';
  }
}
function maybeAutoSync() {
  if (state.db && ext.ready && ghOk() && state.db.syncedAt && Date.now() - state.db.syncedAt > 6 * 3600e3) runSync();
}
async function walkFeed(fetchPage, onItems, label, incremental) {
  let next = null, page = 0;
  do {
    if (sync.stop) return;
    setStatus(`${label}, pagina ${++page}`);
    const r = await fetchPage(next);
    const fresh = onItems(r.items || []);
    next = r.next;
    if (incremental && fresh === 0) break;
    if (next) await politePause();
  } while (next);
}

async function runSync() {
  if (sync.running) { sync.stop = true; setStatus('sync stopt na deze stap…'); return; }
  if (!ext.ready) return toast('Installeer eerst de inspo-extensie in Chrome.');
  if (!ghOk()) return toast('Koppel eerst GitHub in instellingen. Daar worden de thumbnails bewaard.');
  sync.running = true; sync.stop = false; updateSyncUi();
  const db = state.db;
  const incremental = !!db.syncedAt;
  const meta = new Map();
  const start = Date.now();
  let order = 0, added = 0, batch = [];

  const ensure = (m) => {
    if (!db.posts[m.code]) {
      addPost(db, { code: m.code, type: typeFromMedia(m, 'p'), owner: m.owner, caption: m.caption, savedAt: start - (order++) * 1000 });
      added++;
      return true;
    }
    return false;
  };
  const flush = async () => {
    if (!batch.length) return;
    const files = batch; batch = [];
    await ghLocked(async () => {
      const remote = await ghGet();
      if (remote) mergeInto(state.db, await decryptDb(remote, state.password));
      state.db.updatedAt = Date.now();
      const blob = await encryptDb(state.db, state.password);
      const all = [...files, { path: DATA_FILE, b64: b64(te.encode(blob)) }];
      await ghCommitFiles(all, `Sync: ${files.length} thumbnails`);
      state.sha = all[all.length - 1].sha;
      store.set('cache', blob);
    });
    clearTimeout(saveTimer); saveTimer = null;
    refreshThumbs();
  };

  try {
    // 1. Alle opgeslagen posts (nieuwste eerst)
    await walkFeed((maxId) => extCall('savedPage', { maxId }), (items) => {
      let fresh = 0;
      for (const m of items) { meta.set(m.code, m); if (ensure(m)) fresh++; applyMeta(db.posts[m.code], m); }
      return fresh;
    }, 'opgeslagen ophalen', incremental);

    // 2. Collecties
    if (!sync.stop) {
      const { collections } = await extCall('collections');
      for (const c of collections) {
        if (sync.stop) break;
        if (!db.collections.includes(c.name)) db.collections.push(c.name);
        await politePause();
        await walkFeed((maxId) => extCall('collectionPage', { id: c.id, maxId }), (items) => {
          let fresh = 0;
          for (const m of items) {
            meta.set(m.code, m); ensure(m);
            const p = db.posts[m.code];
            if (!p.collections.includes(c.name)) { p.collections.push(c.name); fresh++; }
            applyMeta(p, m);
          }
          return fresh;
        }, `collectie ${c.name}`, incremental);
      }
    }
    const y = scrollY; render(); scrollTo(0, y);

    // 3. Thumbnails
    const todo = Object.values(db.posts).filter(p => !p.thumb && !p.gone && !p.hidden);
    let n = 0;
    for (const p of todo) {
      if (sync.stop) break;
      setStatus(`thumbnails ${++n} van ${todo.length}`);
      let m = meta.get(p.code);
      try {
        if (!m || !m.thumb) {
          await politePause();
          m = (await extCall('media', { code: p.code })).media;
          meta.set(p.code, m); applyMeta(p, m);
        }
        if (!m.thumb) continue;
        const { b64: data, mime } = await extCall('bytes', { url: m.thumb });
        const jpg = await toJpeg(unb64(data), mime, 420);
        const name = await thumbName(p.code);
        thumbMem.set(name, URL.createObjectURL(new Blob([jpg], { type: 'image/jpeg' })));
        batch.push({ path: `thumbs/${name}.bin`, b64: b64(await encThumb(jpg)) });
        p.thumb = name;
        await pause(100);
      } catch (e) {
        if (e.code === 'gone') { p.gone = true; continue; }
        if (e.code === 'http' && /Download/.test(e.message)) continue;   // verlopen CDN-link: volgende keer opnieuw
        throw e;
      }
      if (batch.length >= 40) await flush();
    }
    await flush();
    if (!sync.stop) db.syncedAt = Date.now();
    markDirty();
    toast(sync.stop ? 'Sync gestopt. De rest volgt bij de volgende sync.' : `Sync klaar${added ? `, ${added} nieuwe posts` : ''}.`);
  } catch (e) {
    try { await flush(); } catch {}
    markDirty();
    setStatus('sync gestopt: ' + e.message, 'err');
    toast(e.message);
  } finally {
    sync.running = false; sync.stop = false;
    updateSyncUi();
    const y = scrollY; render(); scrollTo(0, y);
  }
}

/* ---------- Eigen speler ----------
 * Met de extensie spelen we de video zelf af, met een tijdlijn. Zonder extensie: de Instagram-embed. */
let stageToken = 0, player = null;
const mediaCache = new Map();
async function getMedia(code) {
  const c = mediaCache.get(code);
  if (c && Date.now() - c.at < 20 * 60e3) return c.media;
  const { media } = await extCall('media', { code });
  mediaCache.set(code, { media, at: Date.now() });
  return media;
}
function setupStage(p) {
  const crop = $('#sCrop');
  destroyPlayer(); unmountEmbed(crop);
  crop.dataset.code = p.code;
  crop.className = 'crop big';
  crop.style.setProperty('--r', p.w && p.h ? p.w / p.h : (p.type === 'p' ? 0.8 : 9 / 16));
  crop.innerHTML = `<span class="ph">${esc(p.owner ? '@' + p.owner : p.code)}</span>`;
  $('#sKeys').hidden = true;
  if (p.thumb) {
    const img = document.createElement('img');
    img.className = 'poster'; img.alt = '';
    crop.append(img);
    thumbUrl(p.thumb).then(u => { img.src = u; img.classList.add('in'); }).catch(() => img.remove());
  }
  const token = ++stageToken;
  if (!ext.ready) { mountEmbed(crop, p, true); return; }
  crop.classList.add('loading');
  getMedia(p.code).then((m) => {
    if (token !== stageToken) return;
    if (applyMeta(p, m)) markDirty();
    mountPlayer(crop, p, m, 0);
  }).catch((e) => {
    if (token !== stageToken) return;
    crop.classList.remove('loading');
    crop.querySelector('.poster')?.remove();
    if (e.code === 'gone') { markGone(crop, p); return; }
    mountEmbed(crop, p, true);
    if (e.code === 'login' || e.code === 'rate') toast(e.message);
  });
}

function mountPlayer(crop, p, m, idx) {
  destroyPlayer();
  const it = m.items[idx] || m.items[0];
  crop.classList.remove('loading');
  if (it.w && it.h) crop.style.setProperty('--r', it.w / it.h);
  const wrap = document.createElement('div');
  wrap.className = 'vp';
  if (it.video) {
    wrap.innerHTML = `<video playsinline loop preload="auto"></video>
      <div class="vp-ui">
        <div class="vp-row">
          <button class="vp-b" data-act="play"></button>
          <span class="vp-t vp-cur">0:00</span>
          <span class="vp-gap"></span>
          <button class="vp-b" data-act="rate" title="Snelheid">1×</button>
          <button class="vp-b" data-act="mute"></button>
          <span class="vp-t vp-left"></span>
        </div>
        <div class="vp-bar" aria-label="Tijdlijn"><i class="vp-track"></i><i class="vp-buf"></i><i class="vp-fill"></i><span class="vp-tip"></span></div>
      </div>`;
  } else {
    wrap.innerHTML = `<img class="full" alt="">`;
  }
  if (m.items.length > 1) {
    wrap.insertAdjacentHTML('beforeend', `<div class="vp-dots">${m.items.map((_, k) =>
      `<button data-k="${k}" class="${k === idx ? 'on' : ''}" aria-label="Onderdeel ${k + 1} van ${m.items.length}"></button>`).join('')}</div>`);
  }
  crop.append(wrap);
  wrap.querySelector('.vp-dots')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (b) { e.stopPropagation(); mountPlayer(crop, p, m, +b.dataset.k); }
  });

  if (!it.video) {
    const img = wrap.querySelector('img');
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => crop.querySelector('.poster')?.remove(), { once: true });
    img.src = it.image || it.thumb;
    player = { wrap };
    $('#sKeys').hidden = true;
    return;
  }

  const v = wrap.querySelector('video');
  player = { wrap, v };
  $('#sKeys').hidden = false;
  const ui = {
    cur: $('.vp-cur', wrap), left: $('.vp-left', wrap), fill: $('.vp-fill', wrap), buf: $('.vp-buf', wrap),
    bar: $('.vp-bar', wrap), tip: $('.vp-tip', wrap),
    play: $('[data-act=play]', wrap), mute: $('[data-act=mute]', wrap), rate: $('[data-act=rate]', wrap),
  };
  const fmt = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  const dur = () => (isFinite(v.duration) && v.duration) || it.dur || 0;
  const paint = () => {
    const d = dur();
    ui.cur.textContent = fmt(v.currentTime);
    ui.left.textContent = '−' + fmt(d - v.currentTime);
    ui.fill.style.transform = `scaleX(${d ? Math.min(1, v.currentTime / d) : 0})`;
    if (v.buffered.length && d) ui.buf.style.transform = `scaleX(${Math.min(1, v.buffered.end(v.buffered.length - 1) / d)})`;
  };
  const syncUi = () => {
    ui.play.textContent = v.paused ? 'speel' : 'pauze';
    ui.mute.textContent = v.muted ? 'geluid aan' : 'geluid uit';
    wrap.classList.toggle('paused', v.paused);
  };
  let raf = 0;
  const loop = () => { paint(); raf = requestAnimationFrame(loop); };
  player.stop = () => cancelAnimationFrame(raf);
  v.addEventListener('play', () => { syncUi(); cancelAnimationFrame(raf); loop(); });
  v.addEventListener('pause', () => { syncUi(); cancelAnimationFrame(raf); paint(); });
  v.addEventListener('volumechange', syncUi);
  for (const ev of ['loadedmetadata', 'progress', 'seeked']) v.addEventListener(ev, paint);
  v.addEventListener('playing', () => crop.querySelector('.poster')?.remove(), { once: true });
  v.addEventListener('error', () => {
    if (!player || player.v !== v) return;
    destroyPlayer();
    mountEmbed(crop, p, true);
    toast('De video laden lukte niet. Je ziet nu de Instagram-embed.');
  }, { once: true });

  v.addEventListener('click', togglePlay);
  wrap.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') togglePlay();
    else if (act === 'mute') { v.muted = !v.muted; store.set('muted', v.muted); }
    else if (act === 'rate') {
      const rates = [1, 0.5, 0.25, 2];
      v.playbackRate = rates[(rates.indexOf(v.playbackRate) + 1) % rates.length];
      ui.rate.textContent = v.playbackRate + '×';
    }
  });

  const frac = (x) => { const r = ui.bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)); };
  const seek = (x) => { const d = dur(); if (d) { v.currentTime = frac(x) * d; paint(); } };
  ui.bar.addEventListener('pointerdown', (e) => { ui.bar.setPointerCapture(e.pointerId); wrap.classList.add('scrub'); seek(e.clientX); });
  ui.bar.addEventListener('pointermove', (e) => {
    const f = frac(e.clientX);
    ui.tip.textContent = fmt(f * dur());
    ui.tip.style.left = (f * 100) + '%';
    if (ui.bar.hasPointerCapture(e.pointerId)) seek(e.clientX);
  });
  const endScrub = (e) => { if (ui.bar.hasPointerCapture(e.pointerId)) ui.bar.releasePointerCapture(e.pointerId); wrap.classList.remove('scrub'); };
  ui.bar.addEventListener('pointerup', endScrub);
  ui.bar.addEventListener('pointercancel', endScrub);

  let idle = 0;
  const wake = () => {
    wrap.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => { if (!v.paused && !wrap.classList.contains('scrub')) wrap.classList.add('idle'); }, 1800);
  };
  player.wake = wake;
  wrap.addEventListener('pointermove', wake);
  wake();

  v.muted = store.get('muted', false);
  v.src = it.video;
  syncUi();
  v.play().catch(() => { v.muted = true; v.play().catch(syncUi); });
}
function togglePlay() {
  const v = player && player.v;
  if (!v) return;
  if (v.paused) v.play().catch(() => {}); else v.pause();
}
function destroyPlayer() {
  if (!player) return;
  if (player.v) {
    player.stop?.();
    player.v.pause();
    player.v.removeAttribute('src');
    player.v.load();
  }
  player.wrap.remove();
  player = null;
}
function playerKey(e) {
  const v = player && player.v;
  if (!v) return false;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') togglePlay();
  else if (k === 'j') v.currentTime = Math.max(0, v.currentTime - 5);
  else if (k === 'l') v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
  else if (k === ',') { v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / 30); }
  else if (k === '.') { v.pause(); v.currentTime = v.currentTime + 1 / 30; }
  else if (k === 'm') { v.muted = !v.muted; store.set('muted', v.muted); }
  else return false;
  e.preventDefault();
  player.wake?.();
  return true;
}

/* ---------- Render ---------- */
const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function fmtDate(ms, long = false) {
  if (!ms) return '';
  const d = new Date(ms);
  if (long) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return d.getFullYear() === new Date().getFullYear() ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const typeLabel = { reel: 'reel', p: 'post', tv: 'video' };
const seg = (p) => p.type === 'reel' ? 'reel' : p.type === 'tv' ? 'tv' : 'p';
const postUrl = (p) => `https://www.instagram.com/${seg(p)}/${p.code}/`;
const embedUrl = (p) => postUrl(p) + 'embed/';
const firstLine = (s) => (s || '').split('\n').map(x => x.trim()).find(Boolean) || '';

function visiblePosts() { return Object.values(state.db.posts).filter(p => !p.hidden); }
function inView(p) {
  if (state.view === 'all') return true;
  if (state.view === '__none') return !p.collections.length;
  return p.collections.includes(state.view);
}
function computeList() {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean).map(t => t.replace(/^[#@]/, ''));
  let arr = visiblePosts().filter(inView);
  if (state.tag) arr = arr.filter(p => p.tags.includes(state.tag));
  if (terms.length) {
    arr = arr.filter(p => {
      const hay = [p.owner, p.caption, p.note, p.code, typeLabel[p.type], ...p.tags, ...p.collections].join(' ').toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }
  const by = {
    new: (a, b) => (b.savedAt || 0) - (a.savedAt || 0),
    old: (a, b) => (a.savedAt || 0) - (b.savedAt || 0),
    owner: (a, b) => (a.owner || '~').localeCompare(b.owner || '~') || (b.savedAt - a.savedAt),
    edited: (a, b) => (b.editedAt || 0) - (a.editedAt || 0) || (b.savedAt - a.savedAt),
  }[state.sort];
  return arr.sort(by);
}
function viewName() {
  if (state.view === 'all') return 'alles';
  if (state.view === '__none') return 'zonder collectie';
  return state.view;
}

function renderRail() {
  const posts = visiblePosts();
  const rows = [['all', 'alles', posts.length]];
  for (const c of state.db.collections) rows.push([c, c, posts.filter(p => p.collections.includes(c)).length]);
  const none = posts.filter(p => !p.collections.length).length;
  if (none && state.db.collections.length) rows.push(['__none', 'zonder collectie', none]);
  if (!rows.some(r => r[0] === state.view)) state.view = 'all';
  $('#colls').innerHTML = rows.map(([id, label, n]) =>
    `<button class="${id === state.view ? 'on' : ''}" data-view="${esc(id)}"><span>${esc(label)}</span><span class="n">${n}</span></button>`).join('');

  const counts = new Map();
  for (const p of posts.filter(inView)) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  if (state.tag && !counts.has(state.tag)) state.tag = null;
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $('#tags').innerHTML = tags.map(([t, n]) =>
    `<button class="${t === state.tag ? 'on' : ''}" data-tag="${esc(t)}"><span>#${esc(t)}</span><span class="n">${n}</span></button>`).join('');
  $('#tagList').innerHTML = [...allTags()].map(t => `<option value="${esc(t)}">`).join('');
}
function allTags() { const s = new Set(); for (const p of Object.values(state.db.posts)) p.tags.forEach(t => s.add(t)); return s; }

function tileHtml(p, i) {
  const who = p.owner ? '@' + p.owner : p.code;
  return `<button class="tile" data-i="${i}" aria-label="${esc(who)}">
    ${cropHtml(p)}
    ${p.note ? '<i class="mark-note" title="heeft notitie"></i>' : ''}
    <figcaption><b>${esc(who)}</b><span>${esc(firstLine(p.caption) || p.tags.map(t => '#' + t).join(' '))}</span></figcaption>
  </button>`;
}
function cropHtml(p) {
  const who = esc(p.owner ? '@' + p.owner : p.code);
  if (p.gone) return `<div class="crop gone"><span class="ph">${who}<br>niet meer beschikbaar</span></div>`;
  if (p.thumb) return `<div class="crop thumb"><img alt="" data-thumb="${esc(p.thumb)}"><span class="ph">${who}</span></div>`;
  return `<div class="crop"><span class="ph">${who}</span></div>`;
}
function rowHtml(p, i) {
  const cap = firstLine(p.caption);
  return `<li tabindex="0" data-i="${i}">
    <span class="r-owner">${esc(p.owner ? '@' + p.owner : p.code)}</span>
    <span class="r-cap">${p.tags.length ? `<span class="r-tags">${esc(p.tags.map(t => '#' + t).join(' '))}</span> ` : ''}${esc(cap)}</span>
    <span class="r-coll">${esc(p.collections.join(', '))}</span>
    <span class="r-date">${fmtDate(p.savedAt)}</span>
  </li>`;
}

/* ---------- Embeds als beeld ----------
 * De officiële Instagram-embed wordt bijgesneden tot alleen het beeld. De embed meldt zijn hoogte
 * via postMessage (MEASURE); daaruit leiden we de beeldverhouding af en passen de uitsnede aan.
 * Een embed die nooit meet, is een verwijderde of afgeschermde post. */
const HEAD = 57, FOOT = 151;
const arCache = store.get('ar', {});
const goneCache = new Set(store.get('gone', []));
const frames = new Map(); // contentWindow -> { iframe, crop, p, measured }
let arSaveTimer;
function persistFit() {
  clearTimeout(arSaveTimer);
  arSaveTimer = setTimeout(() => { store.set('ar', arCache); store.set('gone', [...goneCache]); }, 800);
}

window.addEventListener('message', (e) => {
  let host = '';
  try { host = new URL(e.origin).hostname; } catch { return; }
  if (!/(^|\.)instagram\.com$/.test(host)) return;
  let d = e.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
  if (!d || d.type !== 'MEASURE' || !d.details) return;
  const rec = frames.get(e.source);
  if (!rec || rec.measured) return;
  rec.measured = true;
  if (rec.cached) { rec.iframe.classList.add('in'); return; }
  const a = (d.details.height - HEAD - FOOT) / rec.iframe.offsetWidth;
  if (!(a > 0.3 && a < 2.2)) return;
  arCache[rec.p.code] = Math.round(a * 1000) / 1000;
  goneCache.delete(rec.p.code);
  persistFit();
  fitEmbed(rec.crop, rec.iframe, rec.p, a);
  rec.iframe.classList.add('in');
});

function setFit(f, w, left, dy) {
  f.style.setProperty('--w', w + 'cqw');
  f.style.setProperty('--l', left + 'cqw');
  f.style.setProperty('--dy', dy + 'cqw');
}
function fitEmbed(crop, f, p, a) {
  // Staande reels staan in de embed als 9:16 binnen een 4:5-vlak (zwarte balken links en rechts).
  const letterbox = p.type !== 'p' && a > 1.18;
  if (crop.classList.contains('big')) {
    crop.style.setProperty('--r', letterbox ? 9 / 16 : 1 / a);
    return letterbox ? setFit(f, 142.22, -21.11, 0) : setFit(f, 100.6, -0.3, 0);
  }
  if (letterbox) return setFit(f, 144, -22, 0.6);
  const w = Math.max(100, 177.78 / a) * 1.03;      // vul de 9:16-tegel
  setFit(f, w, -(w - 100) / 2, Math.max(0, (a * w - 177.78) / 2));
}

function unmountEmbed(crop) {
  const f = crop.querySelector('iframe');
  if (!f) return;
  for (const [win, rec] of frames) if (rec.iframe === f) frames.delete(win);
  f.remove();
}
function markGone(crop, p) {
  unmountEmbed(crop);
  crop.classList.add('gone');
  const ph = crop.querySelector('.ph');
  if (ph) ph.innerHTML = `${esc(p.owner ? '@' + p.owner : p.code)}<br>niet meer beschikbaar`;
}

function mountEmbed(crop, p, force = false) {
  if (!p || crop.querySelector('iframe')) return;
  if (!force && goneCache.has(p.code)) return markGone(crop, p);
  const f = document.createElement('iframe');
  f.src = embedUrl(p);
  f.tabIndex = -1;
  f.title = p.owner ? '@' + p.owner : p.code;
  f.setAttribute('scrolling', 'no');
  const cached = arCache[p.code];
  const rec = { iframe: f, crop, p, measured: false, cached: !!cached };
  if (cached) fitEmbed(crop, f, p, cached);
  crop.append(f);
  frames.set(f.contentWindow, rec);
  f.addEventListener('load', () => {
    setTimeout(() => {
      if (!rec.measured && f.isConnected) { goneCache.add(p.code); persistFit(); markGone(crop, p); }
    }, 7000);
  }, { once: true });
}

const embedIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const crop = e.target;
    if (e.isIntersecting) mountEmbed(crop, state.list[+crop.closest('[data-i]').dataset.i]);
    else if (!crop.classList.contains('gone')) unmountEmbed(crop);
  }
}, { rootMargin: '900px 0px' });

function render() {
  if (!state.db) return;
  renderRail();
  state.list = computeList();
  $('#viewTitle').textContent = state.tag ? `${viewName()} #${state.tag}` : viewName();
  $('#viewCount').textContent = state.list.length;
  $('#modeWall').classList.toggle('on', state.mode === 'wall');
  $('#modeIndex').classList.toggle('on', state.mode === 'index');
  $('#modeWall').setAttribute('aria-selected', state.mode === 'wall');
  $('#modeIndex').setAttribute('aria-selected', state.mode === 'index');

  embedIO.disconnect();
  thumbIO.disconnect();
  for (const rec of frames.values()) if (!rec.crop.classList.contains('big')) frames.delete(rec.iframe.contentWindow);
  const wall = $('#wall'), index = $('#index');
  wall.hidden = state.mode !== 'wall';
  index.hidden = state.mode !== 'index';
  if (state.mode === 'wall') {
    wall.innerHTML = state.list.map(tileHtml).join('');
    index.innerHTML = '';
    $$('.crop', wall).forEach(c => { if (c.classList.contains('thumb')) thumbIO.observe(c); else if (!c.classList.contains('gone')) embedIO.observe(c); });
  } else {
    index.innerHTML = state.list.map(rowHtml).join('');
    wall.innerHTML = '';
  }

  const empty = $('#empty');
  if (!state.list.length) {
    empty.hidden = false;
    empty.innerHTML = Object.keys(state.db.posts).length
      ? '<h2>Niets gevonden</h2><p>Probeer een andere zoekterm, of kies een andere collectie of tag.</p>'
      : `<h2>Nog leeg</h2><p>Sleep je Instagram-export (.zip) hierheen, of kies <b>importeer</b> linksonder.
         Vraag de export aan via Accountcentrum → Je informatie downloaden → Opgeslagen → JSON.</p>`;
  } else empty.hidden = true;
}
function showEmptyHint() { render(); }

/* ---------- Peek (index) ---------- */
let peekTimer = null, peekCode = null;
function showPeek(i, x, y) {
  const p = state.list[i]; if (!p) return;
  const peek = $('#peek');
  peek.hidden = false;
  placePeek(x, y);
  if (peekCode === p.code) return;
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    peekCode = p.code;
    const crop = $('.crop', peek);
    unmountEmbed(crop);
    crop.outerHTML = cropHtml(p);
    const fresh = $('.crop', peek);
    if (p.thumb) showThumb(fresh, p); else if (!p.gone) mountEmbed(fresh, p);
  }, 120);
}
function placePeek(x, y) {
  const peek = $('#peek'); const w = 190, h = w * 16 / 9;
  let left = x + 28, top = y - h / 2;
  if (left + w > innerWidth - 12) left = x - w - 28;
  top = Math.max(12, Math.min(innerHeight - h - 12, top));
  peek.style.left = left + 'px'; peek.style.top = top + 'px';
}
function hidePeek() { clearTimeout(peekTimer); $('#peek').hidden = true; }

/* ---------- Geschiedenis ----------
 * Elke collectie, tag of weergave is een stap in de browsergeschiedenis, net als een geopende post.
 * Zo gaat de terugknop (ook de veeggebaar op mobiel) naar de vorige stap in plaats van de site uit. */
let fromHistory = false;
const navState = () => ({ view: state.view, tag: state.tag, mode: state.mode });
function navUrl(st, code) {
  const q = new URLSearchParams();
  if (st.view && st.view !== 'all') q.set('c', st.view);
  if (st.tag) q.set('t', st.tag);
  if (st.mode === 'index') q.set('m', 'index');
  const qs = q.toString();
  return location.pathname + (qs ? '?' + qs : '') + (code ? '#' + code : '');
}
function pushNav() {
  if (fromHistory) return;
  const st = navState();
  const cur = history.state || {};
  if (cur.view === st.view && cur.tag === st.tag && cur.mode === st.mode && !cur.post) return;
  history.pushState(st, '', navUrl(st));
}
function initNav() {
  const q = new URLSearchParams(location.search);
  if (q.has('c')) state.view = q.get('c');
  if (q.has('t')) state.tag = q.get('t');
  if (q.get('m') === 'index') state.mode = 'index';
  history.replaceState(navState(), '', navUrl(navState()));
}
window.addEventListener('popstate', (e) => {
  if (!state.db) return;
  const st = e.state || { view: 'all', tag: null, mode: state.mode };
  fromHistory = true;
  try {
    const changed = (st.view || 'all') !== state.view || (st.tag || null) !== state.tag || (st.mode && st.mode !== state.mode);
    if (!$('#screen').hidden && !st.post) closeScreen(!changed);
    state.view = st.view || 'all'; state.tag = st.tag || null;
    if (st.mode) state.mode = st.mode;
    store.set('view', state.view);
    if (changed) { render(); scrollTo({ top: 0 }); }
    if (st.post) {
      if (changed || !state.list.length) state.list = computeList();
      const i = state.list.findIndex(p => p.code === st.post);
      if (i >= 0) openPost(i);
    }
  } finally { fromHistory = false; }
});

/* ---------- Screening ---------- */
function openPost(i) {
  const p = state.list[i];
  if (!p) return;
  if (!fromHistory) {
    const st = { ...navState(), post: p.code };
    if ((history.state || {}).post) history.replaceState(st, '', navUrl(st, p.code));
    else history.pushState(st, '', navUrl(st, p.code));
  }
  hidePeek();
  state.openIdx = i;
  const scr = $('#screen');
  const wasHidden = scr.hidden;
  scr.hidden = false;
  document.body.style.overflow = 'hidden';
  const crop = $('#sCrop');
  if (crop.dataset.code !== p.code) setupStage(p);
  $('#sOwner').textContent = p.owner ? '@' + p.owner : p.code;
  $('#sOwner').href = p.owner ? `https://www.instagram.com/${encodeURIComponent(p.owner)}/` : postUrl(p);
  $('#sMeta').textContent = `${typeLabel[p.type] || 'post'}${p.dur ? ', ' + fmtDur(p.dur) : ''}${p.savedAt ? ', opgeslagen ' + fmtDate(p.savedAt, true) : ''}`;
  $('#sColls').innerHTML = p.collections.map(c => `<button class="text" data-view="${esc(c)}">${esc(c)}</button>`).join('');
  $('#sCaption').textContent = p.caption || '';
  $('#sNote').value = p.note || '';
  $('#sOpen').href = postUrl(p);
  $('#sPos').textContent = `${i + 1} van ${state.list.length}`;
  $('#sPrev').disabled = i === 0;
  $('#sNext').disabled = i === state.list.length - 1;
  renderScreenTags(p);
  if (wasHidden) $('#sClose').focus({ preventScroll: true });
}
function renderScreenTags(p) {
  $('#sTags').innerHTML = p.tags.map(t => `<button class="text" data-rm="${esc(t)}" title="verwijder tag">#${esc(t)}</button>`).join('');
}
function closeScreen(rerender = true) {
  // Gesloten via knop of Esc: de geschiedenisstap van de post terugnemen.
  if (!fromHistory && (history.state || {}).post) { history.back(); return; }
  const i = state.openIdx;
  $('#screen').hidden = true;
  document.body.style.overflow = '';
  stageToken++; destroyPlayer();
  const crop = $('#sCrop'); unmountEmbed(crop); crop.innerHTML = ''; crop.dataset.code = '';
  state.openIdx = -1;
  if (rerender) {
    const y = scrollY; render(); scrollTo(0, y);
  }
  $(`[data-i="${i}"]`)?.focus({ preventScroll: true });
}
function currentPost() { return state.list[state.openIdx]; }
function editPost(fn) {
  const p = currentPost(); if (!p) return;
  fn(p); p.editedAt = Date.now(); markDirty();
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3800);
}

/* ---------- Instellingen ---------- */
function openSettings() {
  const c = gh() || DEFAULT_GH;
  $('#gOwner').value = c.owner || ''; $('#gRepo').value = c.repo || ''; $('#gBranch').value = c.branch || 'main';
  $('#gToken').value = c.token || '';
  $('#gMsg').textContent = ''; $('#pMsg').textContent = '';
  if (state.db) {
    const all = Object.values(state.db.posts);
    $('#dStats').textContent = `${all.length} posts, ${state.db.collections.length} collecties, ${all.filter(p => p.hidden).length} verborgen.`;
  }
  updateSyncUi();
  $('#settings').showModal();
}
function readGhForm() {
  return { owner: $('#gOwner').value.trim(), repo: $('#gRepo').value.trim(), branch: $('#gBranch').value.trim() || 'main', token: $('#gToken').value.trim() };
}
function ghMsg(t, cls) { const el = $('#gMsg'); el.textContent = t; el.className = 'msg ' + (cls || ''); }

/* ---------- Events ---------- */
function setCols(n) {
  document.documentElement.style.setProperty('--cols', n);
  $('#cols').value = n;
}
function setView(v) { state.view = v; store.set('view', v); state.tag = null; pushNav(); render(); scrollTo({ top: 0 }); }

function bind() {
  setCols(store.get('cols', 6));
  $('#sort').value = state.sort;

  $('#lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#pw').value;
    if (!state.blob) {
      if (pw.length < 8) return lockMsg('Kies minimaal 8 tekens.', 'err');
      if (pw !== $('#pw2').value) return lockMsg('De wachtwoorden zijn niet gelijk.', 'err');
    }
    await unlock(pw, $('#remember').checked);
    $('#pw').value = ''; $('#pw2').value = '';
  });
  $('#lockSettings').addEventListener('click', openSettings);

  $('#colls').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  $('#tags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]'); if (!b) return;
    state.tag = state.tag === b.dataset.tag ? null : b.dataset.tag; pushNav(); render(); scrollTo({ top: 0 });
  });
  let qTimer;
  $('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; render(); }, 140); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; store.set('sort', state.sort); render(); });
  $('#cols').addEventListener('input', (e) => { setCols(+e.target.value); store.set('cols', +e.target.value); });
  $('#modeWall').addEventListener('click', () => { state.mode = 'wall'; store.set('mode', 'wall'); pushNav(); render(); });
  $('#modeIndex').addEventListener('click', () => { state.mode = 'index'; store.set('mode', 'index'); pushNav(); render(); });

  $('#wall').addEventListener('click', (e) => { const t = e.target.closest('.tile'); if (t) openPost(+t.dataset.i); });
  const idx = $('#index');
  idx.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) openPost(+li.dataset.i); });
  idx.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const li = e.target.closest('li'); if (li) openPost(+li.dataset.i); } });
  idx.addEventListener('mousemove', (e) => {
    const li = e.target.closest('li');
    if (!li) return hidePeek();
    showPeek(+li.dataset.i, e.clientX, e.clientY);
  });
  idx.addEventListener('mouseleave', hidePeek);

  $('#sClose').addEventListener('click', () => closeScreen());
  $('#sPrev').addEventListener('click', () => openPost(state.openIdx - 1));
  $('#sNext').addEventListener('click', () => openPost(state.openIdx + 1));
  $('#sColls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    fromHistory = true; closeScreen(false); fromHistory = false;
    history.replaceState(navState(), '', navUrl(navState()));
    setView(b.dataset.view);
  });
  $('#sNote').addEventListener('input', (e) => editPost(p => { p.note = e.target.value; }));
  $('#sTagIn').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const t = e.target.value.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (!t) return;
    editPost(p => { if (!p.tags.includes(t)) p.tags.push(t); });
    e.target.value = '';
    renderScreenTags(currentPost());
    renderRail();
  });
  $('#sTags').addEventListener('click', (e) => {
    const x = e.target.closest('[data-rm]'); if (!x) return;
    editPost(p => { p.tags = p.tags.filter(t => t !== x.dataset.rm); });
    renderScreenTags(currentPost());
    renderRail();
  });
  $('#sCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(postUrl(currentPost())); toast('Link gekopieerd.'); } catch { toast('Kopiëren lukte niet.'); }
  });
  $('#sHide').addEventListener('click', () => {
    editPost(p => { p.hidden = true; });
    const i = state.openIdx;
    state.list = computeList();
    if (state.list.length) { $('#sCrop').dataset.code = ''; openPost(Math.min(i, state.list.length - 1)); } else closeScreen();
    toast('Verborgen. Terugzetten kan in instellingen.');
  });

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (!$('#screen').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); if (typing) document.activeElement.blur(); else closeScreen(); }
      else if (!typing && !e.metaKey && !e.ctrlKey && playerKey(e)) { /* afgehandeld door de speler */ }
      else if (!typing && e.key === 'ArrowLeft' && state.openIdx > 0) openPost(state.openIdx - 1);
      else if (!typing && e.key === 'ArrowRight' && state.openIdx < state.list.length - 1) openPost(state.openIdx + 1);
      return;
    }
    if (e.key === '/' && !typing && state.db && !$('#settings').open) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && document.activeElement === $('#q')) { $('#q').value = ''; state.q = ''; render(); $('#q').blur(); }
  });

  // Import
  $('#btnImport').addEventListener('click', () => $('#file').click());
  $('#dImport').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async (e) => { await importFiles(e.target.files); e.target.value = ''; });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (!state.db || !e.dataTransfer?.types.includes('Files')) return; dragDepth++; $('#drop').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (state.db) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!state.db) return;
    e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
    await importFiles(e.dataTransfer.files);
  });

  // Sync
  $('#btnSync').addEventListener('click', runSync);
  $('#xSync').addEventListener('click', () => { $('#settings').close(); runSync(); });
  $('#xFull').addEventListener('click', () => { if (sync.running) return; delete state.db.syncedAt; $('#settings').close(); runSync(); });

  // Instellingen
  $('#btnSettings').addEventListener('click', openSettings);
  $('#gTest').addEventListener('click', async () => {
    const c = readGhForm();
    if (!c.owner || !c.repo || !c.token) return ghMsg('Vul eigenaar, repo en token in.', 'err');
    ghMsg('Bezig met testen…');
    try { const r = await ghTest(c); ghMsg(r.msg, r.ok ? 'ok' : 'err'); } catch (e) { ghMsg('Netwerkfout: ' + e.message, 'err'); }
  });
  $('#gSave').addEventListener('click', async () => {
    const c = readGhForm();
    if (!c.owner || !c.repo || !c.token) return ghMsg('Vul eigenaar, repo en token in.', 'err');
    store.set('gh', c);
    ghMsg('Koppeling bewaard.', 'ok');
    if (state.db) {
      try {
        const remote = await ghGet();
        if (remote) mergeInto(state.db, await decryptDb(remote, state.password));
        render(); save();
      } catch (e) { ghMsg('Bewaard, maar ophalen lukte niet: ' + e.message, 'err'); }
    } else {
      const err = await loadBlob();
      showLock(err ? 'Kon de data niet ophalen: ' + err.message : '');
    }
  });
  $('#dBackup').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state.db, null, 2)], { type: 'application/json' }));
    a.download = `inspo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#dUnhide').addEventListener('click', () => {
    let n = 0;
    for (const p of Object.values(state.db.posts)) if (p.hidden) { p.hidden = false; p.editedAt = Date.now(); n++; }
    toast(`${n} posts teruggezet.`); render(); if (n) markDirty();
  });
  $('#pChange').addEventListener('click', () => {
    const pw = $('#pNew').value;
    const el = $('#pMsg');
    if (pw.length < 8) { el.textContent = 'Kies minimaal 8 tekens.'; el.className = 'msg err'; return; }
    state.password = pw;
    if (store.get('pw', null)) store.set('pw', pw);
    $('#pNew').value = '';
    el.textContent = 'Wachtwoord gewijzigd. De data wordt opnieuw versleuteld en opgeslagen.'; el.className = 'msg ok';
    markDirty();
  });
  $('#pLock').addEventListener('click', () => { store.del('pw'); location.reload(); });
}

/* ---------- Start ---------- */
(async function init() {
  bind();
  window.postMessage({ __inspo: 'req', cmd: 'hello' }, location.origin);
  if (!gh()) store.set('gh', { ...DEFAULT_GH });
  const err = await loadBlob();
  showLock(err ? 'Kon de data niet ophalen: ' + err.message + '. De lokale kopie wordt gebruikt als die er is.' : '');
  const pw = store.get('pw', null);
  if (pw && state.blob) await unlock(pw, true);
})();
