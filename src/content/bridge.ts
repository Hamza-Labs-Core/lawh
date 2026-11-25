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
  // Pictures open full size. What is part of a link or a control keeps its own meaning, and so does anything marked
  // data-lawh-viewer="off".
  var SKIP = 'a[href],button,input,select,textarea,label,summary,[role=button],[contenteditable],[data-lawh-viewer="off"]';
  var isMedia = function (el) {
    if (el.closest(SKIP) || (el.parentNode && el.parentNode.closest && el.parentNode.closest('svg'))) return false;
    var box = el.getBoundingClientRect();
    return box.width >= 24 && box.height >= 24;
  };
  var media = function () { return Array.prototype.filter.call(document.querySelectorAll('img,svg,canvas'), isMedia).slice(0, 500); };
  var mark = function () {
    media().forEach(function (el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      if (!el.style.cursor) el.style.cursor = 'zoom-in';
    });
  };
  var labelOf = function (el) {
    var title = el.querySelector && el.querySelector('title');
    var text = el.getAttribute('alt') || el.getAttribute('aria-label') || (title && title.textContent) || '';
    var figure = el.closest('figure'), caption = figure && figure.querySelector('figcaption');
    return Array.from(String(text || (caption && caption.textContent) || '').trim().replace(/\\s+/g, ' ').slice(0, 1000)).slice(0, 100).join('');
  };
  var backgroundOf = function (el) {
    for (var at = el; at && at.nodeType === 1; at = at.parentElement) {
      var color = getComputedStyle(at).backgroundColor;
      if (color && color !== 'transparent' && !/,\\s*0\\)$/.test(color)) return color;
    }
    return 'rgb(255, 255, 255)';
  };
  // The drawing as a file of its own: with the styles the page's sheets gave it.
  var STYLES = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'color', 'font-family', 'font-size',
    'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'visibility', 'display', 'direction', 'stop-color', 'stop-opacity'];
  var drawing = function (svg) {
    var copy = svg.cloneNode(true), box = svg.getBoundingClientRect(), from = [svg].concat(Array.from(svg.querySelectorAll('*'))), to = [copy].concat(Array.from(copy.querySelectorAll('*')));
    for (var i = 0; i < from.length && i < 5000; i++) {
      var style = getComputedStyle(from[i]), out = '';
      for (var j = 0; j < STYLES.length; j++) out += STYLES[j] + ':' + style.getPropertyValue(STYLES[j]) + ';';
      to[i].setAttribute('style', out);
    }
    copy.removeAttribute('tabindex');
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', '0 0 ' + box.width + ' ' + box.height);
    copy.setAttribute('width', String(box.width)); copy.setAttribute('height', String(box.height));
    return { kind: 'svg', text: new XMLSerializer().serializeToString(copy), width: box.width, height: box.height };
  };
  var picture = function (el) {
    if (el.tagName.toLowerCase() === 'svg') return Promise.resolve(drawing(el));
    if (el.tagName === 'IMG') {
      var url = new URL(el.currentSrc || el.src, document.baseURI), here = new URL(location.href), parts = url.pathname.split('/');
      if (url.origin === here.origin && parts[1] === here.pathname.split('/')[1]) return Promise.resolve({ kind: 'image', path: parts.slice(2).map(decodeURIComponent).join('/') });
    }
    return createImageBitmap(el).then(function (bitmap) { return { kind: 'bitmap', bitmap: bitmap }; });
  };
  var openMedia = function (index) {
    var all = media(), el = all[index];
    if (!el) return;
    var failed = { kind: 'none' };
    Promise.resolve().then(function () { return picture(el); }).catch(function () { return failed; }).then(function (data) {
      data.index = index; data.total = all.length; data.label = labelOf(el); data.background = backgroundOf(el); data.type = 'lawh:open-media';
      // A bitmap made from another origin's pixels can't be sent.
      try { parent.postMessage(data, app, data.bitmap ? [data.bitmap] : []); } catch (e) { parent.postMessage({ type: 'lawh:open-media', kind: 'none', index: index, total: all.length, label: data.label, background: data.background }, app); }
    });
  };
  addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var at = event.target;
    while (at && at.nodeType !== 1) at = at.parentNode;
    if (!at || !at.closest) return;
    var all = media();
    for (var el = at; el; el = el.parentElement) { var index = all.indexOf(el); if (index !== -1) { openMedia(index); return; } }
  });
  addEventListener('keydown', function (event) {
    if (event.defaultPrevented || (event.key !== 'Enter' && event.key !== ' ')) return;
    var index = media().indexOf(document.activeElement);
    if (index !== -1) { event.preventDefault(); openMedia(index); }
  });
  addEventListener('message', function (event) {
    if (event.source !== parent || event.origin !== app || !event.data) return;
    if (event.data.type === 'lawh:show-media') openMedia(Number(event.data.index));
    if (event.data.type === 'lawh:focus-media') { var el = media()[Number(event.data.index)]; if (el) el.focus(); }
  });
  var ready = function () {
    outline(); scroll(); mark();
    var soon = 0;
    new MutationObserver(function () { clearTimeout(soon); soon = setTimeout(mark, 300); }).observe(document.body || root, { childList: true, subtree: true });
    addEventListener('load', mark);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready); else ready();
})();
`;
