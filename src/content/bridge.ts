/**
 * The bridge: added to every HTML page. It runs in the page's own realm, so a page can forge anything it sends; the
 * app treats its messages as untrusted (security model, section 3). Plain old JavaScript, no build step.
 */
export const BRIDGE = `(function () {
  'use strict';
  var me = document.currentScript, root = document.documentElement, app = (me && me.dataset.app) || 'null';
  var send = function (type, data) {
    try { data.type = 'lawh:' + type; parent.postMessage(data, app); } catch (e) { /* not a thing a page can fix */ }
  };
  var set = function (mode, lang) {
    if (mode === 'dark' || mode === 'light') root.dataset.lawhMode = mode;
    if (lang === 'en' || lang === 'ar') root.dataset.lawhLang = lang;
  };
  if (me) set(me.dataset.mode, me.dataset.lang);
  addEventListener('message', function (event) {
    if (event.source !== parent || event.origin !== app || !event.data || event.data.type !== 'lawh:theme') return;
    set(event.data.mode, event.data.lang);
  });
  var slug = function (title) {
    // Without marks: Arabic diacritics aren't letters, and would break a word in pieces.
    var plain = title.normalize('NFD').replace(/\\p{M}+/gu, '').normalize('NFC').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '-');
    return Array.from(plain).slice(0, 60).join('').replace(/^-+|-+$/g, '') || 'section';
  };
  var outline = function () {
    var items = [], seen = Object.create(null), all = document.querySelectorAll('h1,h2,h3,h4');
    for (var i = 0; i < all.length && items.length < 200; i++) {
      var h = all[i], title = Array.from((h.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 1000)).slice(0, 100).join('');
      if (!title) continue;
      if (!h.id) {
        var id = 's-' + slug(title), unique = id;
        for (var n = 2; seen[unique] || document.getElementById(unique); n++) unique = id + '-' + n;
        h.id = unique;
      }
      if (h.id.length > 200) continue;
      seen[h.id] = true;
      items.push({ id: h.id, title: title, level: Number(h.tagName[1]) });
    }
    send('outline', { items: items });
  };
  var scroll = function () { send('scroll-state', { top: Math.max(0, Math.round(scrollY)), height: Math.round(root.scrollHeight), view: Math.round(innerHeight) }); };
  var waiting = false;
  addEventListener('scroll', function () {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(function () { waiting = false; scroll(); });
  }, { passive: true });
  var target = function (link) {
    var href = link.href;
    if (href && typeof href === 'object') href = href.baseVal;
    return href || link.getAttribute('href') || link.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
  };
  addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var at = event.target;
    while (at && at.nodeType !== 1) at = at.parentNode;
    var link = at && at.closest && at.closest('a,area');
    if (!link) return;
    var raw = target(link), here = new URL(location.href), url;
    if (!raw) return;
    try { url = new URL(raw, document.baseURI); } catch (e) { event.preventDefault(); return; }
    if (url.origin === here.origin && url.pathname.split('/')[1] === here.pathname.split('/')[1]) {
      // Another file of this page: it keeps the theme and language.
      if ((url.pathname === here.pathname && url.search === here.search) || typeof link.href !== 'string') return;
      if (root.dataset.lawhMode) url.searchParams.set('mode', root.dataset.lawhMode);
      if (root.dataset.lawhLang) url.searchParams.set('lang', root.dataset.lawhLang);
      link.href = url.href;
      return;
    }
    event.preventDefault();
    if (url.protocol === 'https:' && url.href.length <= 2000) send('open-link', { url: url.href });
  });
  var ready = function () { outline(); scroll(); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready); else ready();
})();
`;
