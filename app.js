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

function mergeDb(local, remote) {
  const out = JSON.parse(JSON.stringify(local));
  for (const c of remote.collections || []) if (!out.collections.includes(c)) out.collections.push(c);
  for (const [code, rp] of Object.entries(remote.posts || {})) {
    const lp = out.posts[code];
    if (!lp) { out.posts[code] = rp; continue; }
    for (const c of rp.collections || []) if (!lp.collections.includes(c)) lp.collections.push(c);
    for (const k of ['owner', 'caption', 'thumb']) if (!lp[k] && rp[k]) lp[k] = rp[k];
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
      try { await ghPut(blob); }
      catch (e) {
        if (!e.conflict) throw e;
        // Remote is intussen gewijzigd (bijv. door de sync-extensie): samenvoegen en opnieuw proberen
        const remote = await ghGet();
        if (remote) state.db = mergeDb(state.db, await decryptDb(remote, state.password));
        render();
        blob = await encryptDb(state.db, state.password);
        store.set('cache', blob);
        await ghPut(blob);
      }
      setStatus('opgeslagen', 'ok');
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
    <div class="crop"><span class="ph">${esc(who)}</span></div>
    ${p.note ? '<i class="mark-note" title="heeft notitie"></i>' : ''}
    <figcaption><b>${esc(who)}</b><span>${esc(firstLine(p.caption) || p.tags.map(t => '#' + t).join(' '))}</span></figcaption>
  </button>`;
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
  const rec = { iframe: f, crop, p, measured: false };
  const cached = arCache[p.code];
  if (cached) { rec.measured = true; fitEmbed(crop, f, p, cached); }
  crop.append(f);
  frames.set(f.contentWindow, rec);
  f.addEventListener('load', () => {
    if (cached) f.classList.add('in');
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
  for (const rec of frames.values()) if (!rec.crop.classList.contains('big')) frames.delete(rec.iframe.contentWindow);
  const wall = $('#wall'), index = $('#index');
  wall.hidden = state.mode !== 'wall';
  index.hidden = state.mode !== 'index';
  if (state.mode === 'wall') {
    wall.innerHTML = state.list.map(tileHtml).join('');
    index.innerHTML = '';
    $$('.crop', wall).forEach(c => embedIO.observe(c));
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
    crop.className = 'crop';
    crop.innerHTML = '<span class="ph"></span>';
    mountEmbed(crop, p);
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

/* ---------- Screening ---------- */
function openPost(i) {
  const p = state.list[i];
  if (!p) return;
  hidePeek();
  state.openIdx = i;
  const scr = $('#screen');
  const wasHidden = scr.hidden;
  scr.hidden = false;
  document.body.style.overflow = 'hidden';
  const crop = $('#sCrop');
  if (crop.dataset.code !== p.code) {
    crop.dataset.code = p.code;
    unmountEmbed(crop);
    crop.className = 'crop big';
    crop.style.removeProperty('--r');
    crop.innerHTML = `<span class="ph">${esc(p.owner ? '@' + p.owner : p.code)}</span>`;
    mountEmbed(crop, p, true);
  }
  $('#sOwner').textContent = p.owner ? '@' + p.owner : p.code;
  $('#sOwner').href = p.owner ? `https://www.instagram.com/${encodeURIComponent(p.owner)}/` : postUrl(p);
  $('#sMeta').textContent = `${typeLabel[p.type] || 'post'}${p.savedAt ? ', opgeslagen ' + fmtDate(p.savedAt, true) : ''}`;
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
  const i = state.openIdx;
  $('#screen').hidden = true;
  document.body.style.overflow = '';
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
function setView(v) { state.view = v; store.set('view', v); state.tag = null; render(); scrollTo({ top: 0 }); }

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
    state.tag = state.tag === b.dataset.tag ? null : b.dataset.tag; render(); scrollTo({ top: 0 });
  });
  let qTimer;
  $('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; render(); }, 140); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; store.set('sort', state.sort); render(); });
  $('#cols').addEventListener('input', (e) => { setCols(+e.target.value); store.set('cols', +e.target.value); });
  $('#modeWall').addEventListener('click', () => { state.mode = 'wall'; store.set('mode', 'wall'); render(); });
  $('#modeIndex').addEventListener('click', () => { state.mode = 'index'; store.set('mode', 'index'); render(); });

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
  $('#sColls').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) { closeScreen(false); setView(b.dataset.view); } });
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
        if (remote) state.db = mergeDb(state.db, await decryptDb(remote, state.password));
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
  if (!gh()) store.set('gh', { ...DEFAULT_GH });
  const err = await loadBlob();
  showLock(err ? 'Kon de data niet ophalen: ' + err.message + '. De lokale kopie wordt gebruikt als die er is.' : '');
  const pw = store.get('pw', null);
  if (pw && state.blob) await unlock(pw, true);
})();
