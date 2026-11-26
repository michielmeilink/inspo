// Brug tussen het dashboard (pagina) en de extensie (background).
// De pagina stuurt window.postMessage({ __inspo: 'req', id, cmd, args }); wij antwoorden met { __inspo: 'res', id, ... }.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const origin = location.origin;
  document.documentElement.dataset.inspoExt = VERSION;

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== origin) return;
    const d = e.data;
    if (!d || d.__inspo !== 'req') return;
    if (d.cmd === 'hello') { window.postMessage({ __inspo: 'ready', version: VERSION }, origin); return; }
    let res;
    try { res = await chrome.runtime.sendMessage({ cmd: d.cmd, args: d.args || {} }); }
    catch (err) { res = { ok: false, error: 'Extensie niet bereikbaar: ' + err.message, code: 'ext' }; }
    window.postMessage({ __inspo: 'res', id: d.id, ...(res || { ok: false, error: 'Geen antwoord van de extensie', code: 'ext' }) }, origin);
  });

  window.postMessage({ __inspo: 'ready', version: VERSION }, origin);
})();
