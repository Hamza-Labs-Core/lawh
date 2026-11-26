(function () {
  var root = document.documentElement, get = function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } };
  root.dataset.mode = get('lawh-mode') === 'light' ? 'light' : 'dark';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', root.dataset.mode === 'light' ? '#f6f4ef' : '#12161a');
  var lang = get('lawh-lang') || (/^ar\b/.test(navigator.language || '') ? 'ar' : 'en');
  root.lang = lang === 'ar' ? 'ar' : 'en';
  root.dir = root.lang === 'ar' ? 'rtl' : 'ltr';
})();
