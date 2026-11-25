(function () {
  var root = document.documentElement, get = function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } };
  root.dataset.mode = get('lawh-mode') === 'light' ? 'light' : 'dark';
  var lang = get('lawh-lang') || (/^ar\b/.test(navigator.language || '') ? 'ar' : 'en');
  root.lang = lang === 'ar' ? 'ar' : 'en';
  root.dir = root.lang === 'ar' ? 'rtl' : 'ltr';
})();
