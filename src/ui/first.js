(function () {
  var root = document.documentElement, get = function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } };
  var defMode = root.dataset.defaultMode === 'light' ? 'light' : 'dark';
  var storedMode = get('lawh-mode');
  root.dataset.mode = storedMode === 'light' || storedMode === 'dark' ? storedMode : defMode;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', root.dataset.mode === 'light' ? '#f6f4ef' : '#12161a');
  var configuredLang = root.dataset.defaultLang;
  var defLang = configuredLang === 'ar' || configuredLang === 'en' ? configuredLang : (/^ar\b/.test(navigator.language || '') ? 'ar' : 'en');
  var lang = get('lawh-lang') || defLang;
  root.lang = lang === 'ar' ? 'ar' : 'en';
  root.dir = root.lang === 'ar' ? 'rtl' : 'ltr';
})();
