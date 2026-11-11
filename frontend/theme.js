// Set the theme as early as possible (anti-flash) without inline scripts.
(function () {
  try {
    var pref = localStorage.getItem('tl.theme') || 'system';
    var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
