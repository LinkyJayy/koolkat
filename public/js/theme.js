// Applies the saved theme before the page paints, so there's no flash of the
// wrong colours. Loaded as a classic (blocking) script from <head>.
(function () {
  var KEY = 'koolkat.theme';
  var colors = { light: '#ffffff', dark: '#0b1120' };

  function systemTheme() {
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function get() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function apply(choice) {
    var root = document.documentElement;
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colors[choice === 'system' ? systemTheme() : choice]);
  }

  function set(choice) {
    try {
      if (choice === 'light' || choice === 'dark') localStorage.setItem(KEY, choice);
      else localStorage.removeItem(KEY);
    } catch (e) {
      /* storage blocked: the choice lasts for this visit only */
    }
    apply(choice);
  }

  apply(get());
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      apply(get());
    });
  }
  window.koolkatTheme = { get: get, set: set };
})();
