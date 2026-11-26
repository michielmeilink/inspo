// inspo sync — praat met instagram.com in jouw eigen, ingelogde browsersessie.
'use strict';

const APP_ID = '936619743392459';   // het app-id dat instagram.com zelf gebruikt voor zijn web-API
const IG = 'https://www.instagram.com';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VERSION = chrome.runtime.getManifest().version;
const ALLOWED_ORIGINS = ['https://inspo.michielmeilink.com', 'http://localhost:8765'];

function codeToId(code) {
  let id = 0n;
  for (const ch of code.slice(0, 11)) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) throw new Error('Ongeldige post-code: ' + code);
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

function fail(message, code) { return Object.assign(new Error(message), { code }); }
const HEADERS = { 'X-IG-App-ID': APP_ID, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };

/* Eerst direct vanuit de extensie proberen. Lukt dat niet (cookies niet meegestuurd), dan
 * het verzoek uitvoeren in een instagram.com-tab, waar het een gewoon same-origin verzoek is. */
let viaTab = false;

async function direct(path) {
  const r = await fetch(IG + path, { credentials: 'include', headers: HEADERS });
  return { status: r.status, text: await r.text() };
}

function waitLoaded(tabId) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, 20000);
  });
}

async function igTabId() {
  const tabs = await chrome.tabs.query({ url: IG + '/*' });
  if (tabs.length) return tabs[0].id;
  const tab = await chrome.tabs.create({ url: IG + '/', active: false, pinned: true });
  await waitLoaded(tab.id);
  return tab.id;
}

async function inTab(path) {
  const tabId = await igTabId();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [path, HEADERS],
    func: async (p, headers) => {
      const r = await fetch(p, { credentials: 'include', headers });
      return { status: r.status, text: await r.text() };
    },
  });
  return result;
}

const looksJson = (t) => /^\s*\{/.test(t || '');

async function api(path) {
  let res = viaTab ? await inTab(path) : await direct(path);
  if (!viaTab && (res.status === 401 || res.status === 403 || (res.status === 200 && !looksJson(res.text)))) {
    viaTab = true;
    res = await inTab(path);
  }
  let j = null;
  if (looksJson(res.text)) { try { j = JSON.parse(res.text); } catch {} }
  const msg = (j && j.message) || '';
  if (res.status === 429) throw fail('Instagram vraagt om even te wachten. Probeer het over een uur opnieuw.', 'rate');
  if (/login_required|checkpoint/.test(msg) || res.status === 401) throw fail('Log in op instagram.com in deze browser en probeer het opnieuw.', 'login');
  if (res.status === 404 || (res.status === 400 && /media|not found|invalid/i.test(msg))) throw fail('Post niet gevonden', 'gone');
  if (res.status !== 200 || !j) throw fail(`Instagram gaf status ${res.status}${msg ? ': ' + msg : ''}.`, 'http');
  if (j.status === 'fail') throw fail(msg || 'Instagram weigerde het verzoek.', 'fail');
  return j;
}

/* ---------- Media normaliseren ---------- */
function pick(cands, minW) {
  const list = (cands || []).filter((c) => c && c.url).sort((a, b) => a.width - b.width);
  return list.find((c) => c.width >= minW) || list[list.length - 1] || null;
}
function item(m) {
  const video = (m.video_versions || []).slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  const thumb = pick(m.image_versions2 && m.image_versions2.candidates, 480);
  const large = pick(m.image_versions2 && m.image_versions2.candidates, 1080);
  return {
    type: m.media_type, w: m.original_width || 0, h: m.original_height || 0, dur: m.video_duration || 0,
    video: video ? video.url : null, image: large ? large.url : null, thumb: thumb ? thumb.url : null,
  };
}
function media(m) {
  const items = Array.isArray(m.carousel_media) && m.carousel_media.length ? m.carousel_media.map(item) : [item(m)];
  const first = items[0] || {};
  return {
    code: m.code, mt: m.media_type, product: m.product_type || '',
    owner: (m.user && m.user.username) || (m.owner && m.owner.username) || '',
    caption: (m.caption && m.caption.text) || '',
    takenAt: (m.taken_at || 0) * 1000,
    w: first.w, h: first.h, dur: first.dur, thumb: first.thumb, items,
  };
}
const feedItems = (j) => (j.items || []).map((x) => x.media || x).filter((m) => m && m.code).map(media);

/* ---------- Commando's ---------- */
const handlers = {
  async ping() { return { version: VERSION }; },

  async media({ code }) {
    const j = await api(`/api/v1/media/${codeToId(code)}/info/`);
    const m = j.items && j.items[0];
    if (!m) throw fail('Post niet gevonden', 'gone');
    return { media: media(m) };
  },

  async savedPage({ maxId }) {
    const j = await api('/api/v1/feed/saved/posts/' + (maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''));
    return { items: feedItems(j), next: j.more_available ? (j.next_max_id || null) : null };
  },

  async collections() {
    const out = [];
    let maxId = '';
    for (let guard = 0; guard < 20; guard++) {
      const q = `?collection_types=${encodeURIComponent('["MEDIA"]')}&include_public_only=0&get_cover_media_lists=false` +
        (maxId ? `&max_id=${encodeURIComponent(maxId)}` : '');
      const j = await api('/api/v1/collections/list/' + q);
      for (const c of j.items || []) {
        if (c.collection_type && c.collection_type !== 'MEDIA') continue;
        out.push({ id: String(c.collection_id), name: c.collection_name, count: c.collection_media_count || 0 });
      }
      if (!j.more_available || !j.next_max_id) break;
      maxId = j.next_max_id;
    }
    return { collections: out };
  },

  async collectionPage({ id, maxId }) {
    const j = await api(`/api/v1/feed/collection/${encodeURIComponent(id)}/posts/` + (maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''));
    return { items: feedItems(j), next: j.more_available ? (j.next_max_id || null) : null };
  },

  async bytes({ url }) {
    const host = new URL(url).hostname;
    if (!/(^|\.)(cdninstagram\.com|fbcdn\.net)$/.test(host)) throw fail('Host niet toegestaan', 'host');
    // Eerst direct; lukt dat niet, dan vanuit een instagram.com-tab (zelfde context als Instagram zelf).
    let res = null, status = 0;
    try {
      const r = await fetch(url, { credentials: 'omit' });
      status = r.status;
      if (r.ok) res = { buf: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('content-type') || 'image/jpeg' };
    } catch (e) { status = e.message; }
    if (!res) {
      const tabId = await igTabId();
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [url],
        func: async (u) => {
          try {
            const r = await fetch(u, { credentials: 'omit' });
            if (!r.ok) return { status: r.status };
            const b = new Uint8Array(await r.arrayBuffer());
            let s = '';
            for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
            return { b64: btoa(s), mime: r.headers.get('content-type') || 'image/jpeg' };
          } catch (e) { return { status: String(e.message || e) }; }
        },
      });
      if (result && result.b64) return { b64: result.b64, mime: result.mime };
      throw fail(`Download mislukt (${status}${result && result.status ? ', via tab: ' + result.status : ''})`, 'http');
    }
    let s = '';
    for (let i = 0; i < res.buf.length; i += 0x8000) s += String.fromCharCode.apply(null, res.buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), mime: res.mime };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  const handler = handlers[msg && msg.cmd];
  let origin = '';
  try { origin = new URL(sender.url || '').origin; } catch {}
  if (!handler || !ALLOWED_ORIGINS.includes(origin)) { send({ ok: false, error: 'Niet toegestaan', code: 'denied' }); return false; }
  handler(msg.args || {}).then(
    (r) => send({ ok: true, ...r }),
    (e) => send({ ok: false, error: e.message, code: e.code || 'error' }),
  );
  return true;
});
