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
  // How a section begins: the first text after its heading, also when the heading is in a box of its own.
  var quote = function (h) {
    for (var at = h, up = 0; at && at !== document.body && up < 3; at = at.parentElement, up++) {
      for (var n = at.nextElementSibling; n; n = n.nextElementSibling) {
        if (n.matches('script,style,template')) continue;
        if (n.matches('h1,h2,h3,h4') || n.querySelector('h1,h2,h3,h4')) return '';
        var text = Array.from((n.textContent || '').slice(0, 2000).trim().replace(/\\s+/g, ' ')).slice(0, 140).join('');
        if (text) return text;
      }
    }
    return '';
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
      if (h.id.length > 200 || seen[h.id]) continue;
      seen[h.id] = true;
      items.push({ id: h.id, title: title, level: Number(h.tagName[1]), quote: quote(h) });
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
  // data-lawh-viewer="off" or hidden from assistive technology.
  var SKIP = 'a[*|href],button,input,select,textarea,label,summary,[role=button],[contenteditable]:not([contenteditable=false]),[aria-hidden=true],[data-lawh-viewer="off"]';
  var isMedia = function (el) {
    if (el.closest(SKIP) || el.matches('[role=presentation],[role=none]') || (el.parentNode && el.parentNode.closest && el.parentNode.closest('svg'))) return false;
    var box = el.getBoundingClientRect();
    return box.width >= 24 && box.height >= 24 && getComputedStyle(el).visibility !== 'hidden';
  };
  var media = function () { return Array.prototype.filter.call(document.querySelectorAll('img,svg,canvas'), isMedia).slice(0, 500); };
  // The weakest rule there is, in the first layer: any cursor the page chooses wins, also later and in a layer of its own.
  var sheet = document.createElement('style');
  sheet.textContent = '@layer lawh{:where([data-lawh-zoom]){cursor:zoom-in}}';
  (document.head || root).prepend(sheet);
  var mark = function () {
    media().forEach(function (el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      el.setAttribute('data-lawh-zoom', '');
    });
  };
  var labelOf = function (el) {
    var title = el.querySelector && el.querySelector('title');
    var text = el.getAttribute('alt') || el.getAttribute('aria-label') || (title && title.textContent) || '';
    var figure = el.closest('figure'), caption = figure && figure.querySelector('figcaption');
    return Array.from(String(text || (caption && caption.textContent) || '').trim().replace(/\\s+/g, ' ').slice(0, 1000)).slice(0, 100).join('');
  };
  // What is behind it, all layers together, as one plain color: whatever way the page writes colors.
  var backgroundOf = function (el) {
    var layers = [], one = document.createElement('canvas');
    for (var at = el; at && at.nodeType === 1; at = at.parentElement) layers.push(getComputedStyle(at).backgroundColor);
    one.width = one.height = 1;
    var ink = one.getContext('2d', { willReadFrequently: true });
    ink.fillStyle = root.dataset.lawhMode === 'light' ? 'rgb(246, 244, 239)' : 'rgb(18, 22, 26)';
    // In a dark app, a page that says nothing about its colors is drawn on white.
    if (root.dataset.lawhMode !== 'light' && !/dark/.test(getComputedStyle(root).colorScheme)) ink.fillStyle = 'rgb(255, 255, 255)';
    ink.fillRect(0, 0, 1, 1);
    for (var i = layers.length - 1; i >= 0; i--) { ink.fillStyle = 'rgba(0, 0, 0, 0)'; ink.fillStyle = layers[i]; ink.fillRect(0, 0, 1, 1); }
    var d = ink.getImageData(0, 0, 1, 1).data;
    return 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')';
  };
  // The drawing as a file of its own: with the styles the page's sheets gave it, and what it uses from elsewhere in the page.
  var INHERITED = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'color', 'visibility', 'paint-order',
    'marker-start', 'marker-mid', 'marker-end'];
  var TEXT = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing', 'direction', 'dominant-baseline'];
  var OWN = { opacity: '1', display: 'inline', transform: 'none', 'clip-path': 'none', mask: 'none', filter: 'none', 'stop-color': 'rgb(0, 0, 0)', 'stop-opacity': '1' };
  var MAX_SVG = 4500000;
  var inline = function (from, to, whole) {
    var a = [from].concat(Array.from(from.querySelectorAll('*'))), b = [to].concat(Array.from(to.querySelectorAll('*')));
    for (var i = 0; i < a.length && i < 5000; i++) {
      var el = a[i], style = getComputedStyle(el), above = i > 0 && el.parentElement ? getComputedStyle(el.parentElement) : null, out = '', tag = el.tagName.toLowerCase();
      var add = function (name, value) { out += name + ':' + value + ';'; };
      INHERITED.concat(tag === 'svg' || tag === 'text' || tag === 'tspan' || tag === 'textpath' || tag === 'g' ? TEXT : []).forEach(function (name) {
        var value = style.getPropertyValue(name);
        if (value && (!above || value !== above.getPropertyValue(name) || el.hasAttribute(name))) add(name, value);
      });
      // The drawing itself is shown as it is, without the place and turn its page gives it.
      if (i > 0 || whole) Object.keys(OWN).forEach(function (name) {
        var value = style.getPropertyValue(name);
        if (value && value !== OWN[name]) { add(name, value); if (name === 'transform') { add('transform-origin', style.transformOrigin); add('transform-box', style.transformBox || 'view-box'); } }
      });
      b[i].setAttribute('style', ((i > 0 || whole) && b[i].getAttribute('style') ? b[i].getAttribute('style') + ';' : '') + out);
    }
  };
  var drawing = function (svg) {
    var copy = svg.cloneNode(true), size = function (side, client) { try { return svg[side].baseVal.value || client; } catch (e) { return client; } };
    var w = size('width', svg.clientWidth) || 300, h = size('height', svg.clientHeight) || 150, NS = 'http://www.w3.org/2000/svg';
    inline(svg, copy, false);
    // Symbols, gradients and the like that live in another drawing of the page.
    var defs = document.createElementNS(NS, 'defs'), done = {}, text = '', budget = 5000;
    copy.insertBefore(defs, copy.firstChild);
    for (var round = 0; round < 4; round++) {
      text = new XMLSerializer().serializeToString(copy);
      if (text.length > MAX_SVG) return { kind: 'none' };
      var names = text.match(/(?:href="|url\\((?:&quot;|["'])?)#[^"')&]+/g) || [], added = false;
      for (var i = 0; i < names.length && budget > 0; i++) {
        var id = names[i].slice(names[i].indexOf('#') + 1);
        if (done[':' + id]) continue;
        done[':' + id] = true;
        // Its own come first.
        if (copy.querySelector('#' + CSS.escape(id))) continue;
        var target = document.getElementById(id);
        if (!target || svg.contains(target) || !(target instanceof SVGElement) || target.contains(svg)) continue;
        budget -= 1 + target.querySelectorAll('*').length;
        if (budget < 0) break;
        var other = target.cloneNode(true);
        inline(target, other, true); defs.appendChild(other); added = true;
      }
      if (!added) break;
    }
    copy.removeAttribute('tabindex');
    copy.setAttribute('xmlns', NS);
    if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    copy.setAttribute('width', String(w)); copy.setAttribute('height', String(h));
    text = new XMLSerializer().serializeToString(copy);
    return text.length > MAX_SVG ? { kind: 'none' } : { kind: 'svg', text: text, width: w, height: h };
  };
  var picture = function (el) {
    if (el.tagName.toLowerCase() === 'svg') return Promise.resolve(drawing(el));
    if (el.tagName === 'IMG') {
      var url = new URL(el.currentSrc || el.src, document.baseURI), here = new URL(location.href), parts = url.pathname.split('/');
      if (url.origin === here.origin && parts[1] === here.pathname.split('/')[1]) return Promise.resolve({ kind: 'image', path: parts.slice(2).map(decodeURIComponent).join('/') });
    }
    return createImageBitmap(el).then(function (bitmap) { return { kind: 'bitmap', bitmap: bitmap }; });
  };
  // asked: the app wants it, for its arrows.
  var openMedia = function (index, all, asked) {
    var el = all[index];
    // The page took it away since: said, so the arrows don't wait.
    if (!el) { if (index >= 0 && index < 500) parent.postMessage({ type: 'lawh:open-media', asked: asked, kind: 'none', index: index, total: index + 1, label: '', background: 'rgb(0, 0, 0)' }, app); return; }
    var about = { type: 'lawh:open-media', asked: asked, index: index, total: all.length, label: labelOf(el), background: backgroundOf(el) };
    var post = function (data) {
      try { parent.postMessage(Object.assign({}, about, data), app, data.bitmap ? [data.bitmap] : []); }
      // A bitmap made from another origin's pixels can't be sent.
      catch (e) { if (data.bitmap) data.bitmap.close(); parent.postMessage(Object.assign({}, about, { kind: 'none' }), app); }
    };
    Promise.resolve().then(function () { return picture(el); }).catch(function () { return { kind: 'none' }; }).then(post);
  };
  addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var at = event.target;
    while (at && at.nodeType !== 1) at = at.parentNode;
    if (!at || !at.closest || !at.closest('img,svg,canvas')) return;
    var all = media();
    for (var el = at; el; el = el.parentElement) { var index = all.indexOf(el); if (index !== -1) { openMedia(index, all); return; } }
  });
  addEventListener('keydown', function (event) {
    if (event.defaultPrevented || (event.key !== 'Enter' && event.key !== ' ')) return;
    var el = document.activeElement;
    if (!el || !el.matches || !el.matches('img,svg,canvas')) return;
    var all = media(), index = all.indexOf(el);
    if (index !== -1) { event.preventDefault(); openMedia(index, all); }
  });
  addEventListener('message', function (event) {
    if (event.source !== parent || event.origin !== app || !event.data) return;
    if (event.data.type === 'lawh:go-to') { var there = document.getElementById(String(event.data.id)); if (there) there.scrollIntoView(); }
    if (event.data.type === 'lawh:show-media') openMedia(Number(event.data.index), media(), true);
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
