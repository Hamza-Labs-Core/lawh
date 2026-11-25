/**
 * The full-size viewer's page: a second sandboxed frame, so an image of a page is never opened by the app itself
 * (security model, section 3). It draws what the app posts to it on a canvas, and tells the app only key names.
 */
export const VIEWER_HTML = (token: string, app: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viewer</title></head><body><canvas role="img" tabindex="0"></canvas><script src="/${token}/_lawh/viewer.js" data-app="${app}"></script></body></html>`;

export const VIEWER = `(function () {
  'use strict';
  var app = document.currentScript.dataset.app, token = location.pathname.split('/')[1], canvas = document.querySelector('canvas'), pen = canvas.getContext('2d');
  var item = null, width = 0, height = 0, scale = 1, x = 0, y = 0, fitScale = 1, background = 'transparent', shown = 0, waiting = false, release = null;
  document.documentElement.style.cssText = 'height:100%;background:transparent;overscroll-behavior:none';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;outline:none';
  var send = function (type, key) { parent.postMessage({ type: 'lawh:' + type, key: key }, app); };
  var draw = function () {
    if (waiting) return;
    waiting = true;
    requestAnimationFrame(function () {
      waiting = false;
      var ratio = Math.min(devicePixelRatio || 1, 3), w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * ratio)); canvas.height = Math.max(1, Math.round(h * ratio));
      if (!item) return;
      pen.setTransform(ratio, 0, 0, ratio, 0, 0);
      pen.imageSmoothingEnabled = scale < 4;
      pen.imageSmoothingQuality = 'high';
      pen.fillStyle = background; pen.fillRect(x, y, width * scale, height * scale);
      pen.drawImage(item, x, y, width * scale, height * scale);
    });
  };
  // At least a third of the picture stays in view, and one smaller than the view stays in its middle.
  var hold = function () {
    var w = canvas.clientWidth, h = canvas.clientHeight, pw = width * scale, ph = height * scale;
    x = pw <= w ? (w - pw) / 2 : Math.min(w * 2 / 3, Math.max(w / 3 - pw, x));
    y = ph <= h ? (h - ph) / 2 : Math.min(h * 2 / 3, Math.max(h / 3 - ph, y));
    draw();
  };
  var fit = function () {
    fitScale = Math.min(canvas.clientWidth / width, canvas.clientHeight / height) || 1;
    // A small picture is enlarged, to at most four times.
    scale = fitScale = Math.min(fitScale, 4);
    hold();
  };
  var zoom = function (by, cx, cy) {
    if (!item) return;
    var next = Math.min(Math.max(scale * by, Math.min(fitScale, 1) / 2), Math.max(fitScale, 1) * 16);
    if (cx === undefined) { cx = canvas.clientWidth / 2; cy = canvas.clientHeight / 2; }
    x = cx - (cx - x) * next / scale; y = cy - (cy - y) * next / scale; scale = next;
    hold();
  };
  var show = function (source, w, h, ticket, done) {
    if (ticket !== shown) { if (done) done(); return; }
    if (release) release();
    release = done || null;
    item = source; width = Math.max(1, w); height = Math.max(1, h);
    fit();
    send('viewer-shown');
  };
  var load = function (src, w, h, ticket, done) {
    var image = new Image();
    image.onload = function () { show(image, image.naturalWidth || w || 300, image.naturalHeight || h || 150, ticket, done); };
    image.onerror = function () { if (done) done(); if (ticket === shown) send('viewer-failed'); };
    // Allowed by the content host for any origin; the canvas stays readable, as it is for drawings.
    if (src.charAt(0) === '/') image.crossOrigin = 'anonymous';
    image.src = src;
  };
  addEventListener('message', function (event) {
    // The page's own frame can post here too: only the app may say what is shown.
    if (event.source !== parent || event.origin !== app || !event.data) return;
    var data = event.data;
    if (data.type === 'lawh:zoom') { zoom(Number(data.by) || 1); return; }
    if (data.type === 'lawh:fit') { if (item) fit(); return; }
    if (data.type !== 'lawh:view') return;
    var ticket = ++shown;
    item = null; draw();
    canvas.setAttribute('aria-label', String(data.label || ''));
    background = String(data.background || 'transparent');
    if (data.kind === 'image') load('/' + token + '/' + String(data.path).split('/').map(encodeURIComponent).join('/'), 0, 0, ticket);
    else if (data.kind === 'svg') {
      var url = URL.createObjectURL(new Blob([String(data.text)], { type: 'image/svg+xml' }));
      load(url, Number(data.width), Number(data.height), ticket, function () { URL.revokeObjectURL(url); });
    } else if (data.kind === 'bitmap' && data.bitmap instanceof ImageBitmap) show(data.bitmap, data.bitmap.width, data.bitmap.height, ticket);
    else send('viewer-failed');
  });
  var KEYS = { Escape: 1, ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, '+': 1, '=': 1, '-': 1, '0': 1 };
  addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey || !KEYS[event.key]) return;
    event.preventDefault();
    send('key', event.key);
  });
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    var box = canvas.getBoundingClientRect();
    zoom(Math.exp(-Math.max(-60, Math.min(60, event.deltaY * (event.deltaMode === 1 ? 16 : 1))) / 200), event.clientX - box.left, event.clientY - box.top);
  }, { passive: false });
  var fingers = {}, count = function () { return Object.keys(fingers).length; }, lastTap = 0, moved = false;
  var two = function () {
    var ids = Object.keys(fingers), a = fingers[ids[0]], b = fingers[ids[1]];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  canvas.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    fingers[event.pointerId] = { x: event.clientX, y: event.clientY };
    if (count() === 1) moved = false;
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', function (event) {
    var f = fingers[event.pointerId];
    if (!f || !item) return;
    if (count() === 1) {
      if (Math.abs(event.clientX - f.x) + Math.abs(event.clientY - f.y) > 3) moved = true;
      x += event.clientX - f.x; y += event.clientY - f.y; f.x = event.clientX; f.y = event.clientY;
      hold();
    } else if (count() === 2) {
      moved = true;
      var before = two(); f.x = event.clientX; f.y = event.clientY; var after = two();
      x += after.cx - before.cx; y += after.cy - before.cy;
      zoom(after.d / before.d, after.cx, after.cy);
    }
  });
  var up = function (event) {
    if (!fingers[event.pointerId]) return;
    delete fingers[event.pointerId];
    if (count() > 0) return;
    canvas.style.cursor = 'grab';
    if (moved || event.type !== 'pointerup') return;
    // Two taps: fit, or twice as large when it already fits.
    if (event.timeStamp - lastTap < 350) { lastTap = 0; if (Math.abs(scale - fitScale) < 0.01) zoom(2, event.clientX, event.clientY); else fit(); } else lastTap = event.timeStamp;
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  addEventListener('resize', function () { if (item) fit(); });
  send('viewer-ready');
})();
`;
