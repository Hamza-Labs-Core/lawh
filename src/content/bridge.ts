/**
 * The bridge: added to every HTML page. It runs in the page's own realm, so a page can forge anything it sends; the
 * app treats its messages as untrusted (security model, section 3). Plain old JavaScript, no build step.
 */
export const BRIDGE = `(function () {
  'use strict';
  var me = document.currentScript, root = document.documentElement, send = function (type, data) {
    try { data.type = 'lawh:' + type; parent.postMessage(data, '*'); } catch (e) { /* not a thing a page can fix */ }
  };
  var set = function (mode, lang) {
    if (mode === 'dark' || mode === 'light') root.dataset.lawhMode = mode;
    if (lang === 'en' || lang === 'ar') root.dataset.lawhLang = lang;
  };
  if (me) set(me.dataset.mode, me.dataset.lang);
  addEventListener('message', function (event) {
    if (event.source !== parent || !event.data || event.data.type !== 'lawh:theme') return;
    set(event.data.mode, event.data.lang);
  });
  var outline = function () {
    var items = [], seen = {}, all = document.querySelectorAll('h1,h2,h3,h4');
    for (var i = 0; i < all.length && items.length < 200; i++) {
      var h = all[i], title = (h.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
      if (!title) continue;
      if (!h.id) {
        var id = 's-' + (title.toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section');
        var unique = id;
        for (var n = 2; seen[unique] || document.getElementById(unique); n++) unique = id + '-' + n;
        h.id = unique;
      }
      seen[h.id] = true;
      items.push({ id: h.id.slice(0, 200), title: title, level: Number(h.tagName[1]) });
    }
    send('outline', { items: items });
  };
  var scroll = function () { send('scroll-state', { top: Math.round(scrollY), height: Math.round(root.scrollHeight), view: Math.round(innerHeight) }); };
  var waiting = false;
  addEventListener('scroll', function () {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(function () { waiting = false; scroll(); });
  }, { passive: true });
  addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var at = event.target;
    while (at && at.nodeType !== 1) at = at.parentNode;
    var link = at && at.closest && at.closest('a[href]');
    if (!link) return;
    var url;
    try { url = new URL(link.href); } catch (e) { return; }
    var here = new URL(location.href);
    if (url.origin === here.origin && url.pathname === here.pathname) return;
    if (url.origin === here.origin && url.pathname.split('/')[1] === here.pathname.split('/')[1]) return;
    event.preventDefault();
    if (url.protocol === 'https:') send('open-link', { url: url.href.slice(0, 2000) });
  });
  var ready = function () { outline(); scroll(); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready); else ready();
})();
`;
