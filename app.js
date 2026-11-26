/* Inspiratie — dashboard voor opgeslagen Instagram-posts.
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
  view: store.get('view', 'all'), q: '', tag: null, sort: store.get('sort', 'new'),
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
  if (it.caption && !p.caption) p.caption = it.caption;
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
          items.push({ ...p, owner: ownerOf(entry), savedAt: maxTimestamp(entry), collection: isColl ? current : null });
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
function markDirty() { setStatus('Niet opgeslagen', 'warn'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200); }
window.addEventListener('beforeunload', (e) => { if (saveTimer || state.saving) { e.preventDefault(); e.returnValue = ''; } });

async function save() {
  saveTimer = null;
  if (state.saving) { state.again = true; return; }
  state.saving = true;
  setStatus('Opslaan…');
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
      setStatus('Opgeslagen', 'ok');
    } else {
      setStatus('Alleen in deze browser opgeslagen', 'warn');
    }
  } catch (e) {
    setStatus('Opslaan mislukt: ' + e.message, 'err');
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
  else setStatus(ghOk() ? 'Gesynchroniseerd' : 'Niet gekoppeld aan GitHub', ghOk() ? 'ok' : 'warn');
  if (!Object.keys(state.db.posts).length) showEmptyHint();
  return true;
}

/* ---------- Render ---------- */
const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const typeLabel = { reel: 'Reel', p: 'Post', tv: 'Video' };
const postUrl = (p) => `https://www.instagram.com/${p.type === 'reel' ? 'reel' : p.type === 'tv' ? 'tv' : 'p'}/${p.code}/`;
const embedUrl = (p) => postUrl(p) + 'embed/captioned/';
const thumbUrl = (p) => p.thumb || `https://www.instagram.com/p/${p.code}/media/?size=m`;

function visiblePosts() { return Object.values(state.db.posts).filter(p => !p.hidden); }
function inView(p) {
  if (state.view === 'all') return true;
  if (state.view === '__none') return !p.collections.length;
  return p.collections.includes(state.view);
}
function computeList() {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  let arr = visiblePosts().filter(inView);
  if (state.tag) arr = arr.filter(p => p.tags.includes(state.tag));
  if (terms.length) {
    arr = arr.filter(p => {
      const hay = [p.owner, p.caption, p.note, p.code, p.type, ...p.tags, ...p.collections].join(' ').toLowerCase();
      return terms.every(t => hay.includes(t.replace(/^[#@]/, '')));
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

function renderTabs() {
  const posts = visiblePosts();
  const tabs = [['all', 'Alle', posts.length]];
  for (const c of state.db.collections) tabs.push([c, c, posts.filter(p => p.collections.includes(c)).length]);
  const none = posts.filter(p => !p.collections.length).length;
  if (none && state.db.collections.length) tabs.push(['__none', 'Zonder collectie', none]);
  if (!tabs.some(t => t[0] === state.view)) state.view = 'all';
  $('#tabs').innerHTML = tabs.map(([id, label, n]) =>
    `<button class="tab${id === state.view ? ' on' : ''}" data-view="${esc(id)}">${esc(label)}<span class="n">${n}</span></button>`).join('');
}
function renderTagbar() {
  const counts = new Map();
  for (const p of visiblePosts().filter(inView)) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  if (state.tag && !counts.has(state.tag)) state.tag = null;
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $('#tagbar').innerHTML = tags.map(([t, n]) =>
    `<button class="chip${t === state.tag ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)} <span>${n}</span></button>`).join('');
  $('#tagList').innerHTML = [...allTags()].map(t => `<option value="${esc(t)}">`).join('');
}
function allTags() { const s = new Set(); for (const p of Object.values(state.db.posts)) p.tags.forEach(t => s.add(t)); return s; }

function cardHtml(p, i) {
  const initial = (p.owner || '?').replace(/^[^a-z0-9]+/i, '').charAt(0).toUpperCase() || '?';
  return `<button class="card" data-i="${i}" title="${esc(p.owner ? '@' + p.owner : p.code)}">
    <div class="thumb" style="--h:${hue(p.owner || p.code)}">
      <div class="ph"><div><b>${esc(initial)}</b><span>${esc(p.owner ? '@' + p.owner : p.code)}</span></div></div>
      <img loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="" src="${esc(thumbUrl(p))}">
      <span class="badge">${typeLabel[p.type] || 'Post'}</span>
      ${p.note ? '<span class="dot" title="Heeft notitie"></span>' : ''}
      <div class="play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
    </div>
    <div class="meta"><span class="owner">${esc(p.owner ? '@' + p.owner : '—')}</span><span class="date">${fmtDate(p.savedAt)}</span></div>
    ${p.tags.length ? `<div class="ctags">${p.tags.slice(0, 4).map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
  </button>`;
}

function render() {
  if (!state.db) return;
  renderTabs();
  renderTagbar();
  state.list = computeList();
  $('#grid').innerHTML = state.list.map(cardHtml).join('');
  const empty = $('#empty');
  if (!state.list.length) {
    empty.hidden = false;
    empty.innerHTML = Object.keys(state.db.posts).length
      ? '<h2>Niets gevonden</h2><p>Pas je zoekopdracht of filter aan.</p>'
      : emptyHintHtml();
  } else empty.hidden = true;
}
function emptyHintHtml() {
  return `<h2>Nog geen posts</h2>
    <p>Sleep je Instagram-export (.zip of <code>saved_posts.json</code> + <code>saved_collections.json</code>) op deze pagina,<br>of klik op <b>Importeer</b>.</p>`;
}
function showEmptyHint() { render(); }

/* ---------- Speler ---------- */
function openPost(i) {
  const p = state.list[i];
  if (!p) return;
  state.openIdx = i;
  const modal = $('#modal');
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  const frame = $('#frame');
  if (frame.dataset.code !== p.code) { frame.src = embedUrl(p); frame.dataset.code = p.code; }
  $('#mOwner').textContent = p.owner ? '@' + p.owner : p.code;
  $('#mOwner').href = p.owner ? `https://www.instagram.com/${encodeURIComponent(p.owner)}/` : postUrl(p);
  $('#mDate').textContent = [typeLabel[p.type] || 'Post', p.savedAt ? 'opgeslagen ' + fmtDate(p.savedAt) : ''].filter(Boolean).join(' · ');
  $('#mColls').innerHTML = p.collections.map(c => `<span class="chip">${esc(c)}</span>`).join('');
  $('#mCaption').textContent = p.caption || '';
  $('#mNote').value = p.note || '';
  $('#mOpen').href = postUrl(p);
  $('#mPos').textContent = `${i + 1} / ${state.list.length}`;
  $('#mPrev').disabled = i === 0;
  $('#mNext').disabled = i === state.list.length - 1;
  renderModalTags(p);
}
function renderModalTags(p) {
  $('#mTags').innerHTML = p.tags.map(t => `<span class="chip">#${esc(t)} <span class="x" data-rm="${esc(t)}">✕</span></span>`).join('');
}
function closeModal() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  const frame = $('#frame');
  frame.src = 'about:blank'; frame.dataset.code = '';
  const card = $(`.card[data-i="${state.openIdx}"]`);
  state.openIdx = -1;
  render();
  if (card) $(`.card[data-i="${card.dataset.i}"]`)?.focus({ preventScroll: false });
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
  $('#sOwner').value = c.owner || ''; $('#sRepo').value = c.repo || ''; $('#sBranch').value = c.branch || 'main';
  $('#sToken').value = c.token || '';
  $('#sGhMsg').textContent = ''; $('#sPwMsg').textContent = '';
  if (state.db) {
    const all = Object.values(state.db.posts);
    $('#sStats').textContent = `${all.length} posts, ${state.db.collections.length} collecties, ${all.filter(p => p.hidden).length} verborgen.`;
  }
  $('#settings').showModal();
}
function readGhForm() {
  return { owner: $('#sOwner').value.trim(), repo: $('#sRepo').value.trim(), branch: $('#sBranch').value.trim() || 'main', token: $('#sToken').value.trim() };
}
function ghMsg(t, cls) { const el = $('#sGhMsg'); el.textContent = t; el.className = 'msg ' + (cls || ''); }

/* ---------- Events ---------- */
function bind() {
  $('#size').value = store.get('size', 220);
  document.documentElement.style.setProperty('--card', $('#size').value + 'px');
  $('#sort').value = state.sort;

  $('#lockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#pw').value;
    if (!state.blob) {
      if (pw.length < 8) return lockMsg('Kies minimaal 8 tekens.', 'err');
      if (pw !== $('#pw2').value) return lockMsg('Wachtwoorden komen niet overeen.', 'err');
    }
    await unlock(pw, $('#remember').checked);
    $('#pw').value = ''; $('#pw2').value = '';
  });
  $('#lockSettings').addEventListener('click', openSettings);

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    state.view = b.dataset.view; store.set('view', state.view); render(); window.scrollTo({ top: 0 });
  });
  $('#tagbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]'); if (!b) return;
    state.tag = state.tag === b.dataset.tag ? null : b.dataset.tag; render();
  });
  let qTimer;
  $('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; render(); }, 120); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; store.set('sort', state.sort); render(); });
  $('#size').addEventListener('input', (e) => { document.documentElement.style.setProperty('--card', e.target.value + 'px'); store.set('size', +e.target.value); });

  $('#grid').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) openPost(+c.dataset.i); });
  $('#grid').addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

  $('#mClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#mPrev').addEventListener('click', () => openPost(state.openIdx - 1));
  $('#mNext').addEventListener('click', () => openPost(state.openIdx + 1));
  $('#mNote').addEventListener('input', (e) => editPost(p => { p.note = e.target.value; }));
  $('#mTagIn').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const t = e.target.value.trim().replace(/^#/, '').toLowerCase();
    if (!t) return;
    editPost(p => { if (!p.tags.includes(t)) p.tags.push(t); });
    e.target.value = '';
    renderModalTags(currentPost());
    renderTagbar();
  });
  $('#mTags').addEventListener('click', (e) => {
    const x = e.target.closest('[data-rm]'); if (!x) return;
    editPost(p => { p.tags = p.tags.filter(t => t !== x.dataset.rm); });
    renderModalTags(currentPost());
  });
  $('#mCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(postUrl(currentPost())); toast('Link gekopieerd.'); } catch { toast('Kopiëren lukte niet.'); }
  });
  $('#mHide').addEventListener('click', () => {
    editPost(p => { p.hidden = true; });
    const i = state.openIdx;
    state.list = computeList();
    if (state.list.length) openPost(Math.min(i, state.list.length - 1)); else closeModal();
    toast('Verborgen. Terugzetten kan via Instellingen.');
  });

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (!$('#modal').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      else if (!typing && e.key === 'ArrowLeft' && state.openIdx > 0) openPost(state.openIdx - 1);
      else if (!typing && e.key === 'ArrowRight' && state.openIdx < state.list.length - 1) openPost(state.openIdx + 1);
      return;
    }
    if (e.key === '/' && !typing && state.db && !$('#settings').open) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape' && document.activeElement === $('#q')) { $('#q').value = ''; state.q = ''; render(); $('#q').blur(); }
  });

  // Import
  $('#btnImport').addEventListener('click', () => $('#file').click());
  $('#sImport').addEventListener('click', () => $('#file').click());
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
  $('#sTest').addEventListener('click', async () => {
    const c = readGhForm();
    if (!c.owner || !c.repo || !c.token) return ghMsg('Vul eigenaar, repo en token in.', 'err');
    ghMsg('Testen…');
    try { const r = await ghTest(c); ghMsg(r.msg, r.ok ? 'ok' : 'err'); } catch (e) { ghMsg('Netwerkfout: ' + e.message, 'err'); }
  });
  $('#sSaveGh').addEventListener('click', async () => {
    const c = readGhForm();
    if (!c.owner || !c.repo || !c.token) return ghMsg('Vul eigenaar, repo en token in.', 'err');
    store.set('gh', c);
    ghMsg('Opgeslagen.', 'ok');
    if (state.db) {
      // Bestaande remote data ophalen en samenvoegen, daarna wegschrijven
      try {
        const remote = await ghGet();
        if (remote) state.db = mergeDb(state.db, await decryptDb(remote, state.password));
        render(); save();
      } catch (e) { ghMsg('Opgeslagen, maar ophalen lukte niet: ' + e.message, 'warn'); }
    } else {
      const err = await loadBlob();
      showLock(err ? 'Kon data niet ophalen: ' + err.message : '');
    }
  });
  $('#sBackup').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state.db, null, 2)], { type: 'application/json' }));
    a.download = `inspiratie-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#sUnhide').addEventListener('click', () => {
    let n = 0;
    for (const p of Object.values(state.db.posts)) if (p.hidden) { p.hidden = false; p.editedAt = Date.now(); n++; }
    toast(`${n} posts teruggezet.`); render(); if (n) markDirty();
  });
  $('#sChangePw').addEventListener('click', () => {
    const pw = $('#sNewPw').value;
    const el = $('#sPwMsg');
    if (pw.length < 8) { el.textContent = 'Kies minimaal 8 tekens.'; el.className = 'msg err'; return; }
    state.password = pw;
    if (store.get('pw', null)) store.set('pw', pw);
    $('#sNewPw').value = '';
    el.textContent = 'Wachtwoord gewijzigd. Wordt opnieuw versleuteld en opgeslagen.'; el.className = 'msg ok';
    markDirty();
  });
  $('#sLock').addEventListener('click', () => {
    store.del('pw');
    location.reload();
  });
}

/* ---------- Start ---------- */
(async function init() {
  bind();
  if (!gh()) store.set('gh', { ...DEFAULT_GH });
  const err = await loadBlob();
  showLock(err ? 'Kon data niet ophalen: ' + err.message + ' (lokale kopie gebruikt indien aanwezig)' : '');
  const pw = store.get('pw', null);
  if (pw && state.blob) await unlock(pw, true);
})();
