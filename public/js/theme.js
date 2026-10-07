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

  // Emojis: Apple devices keep Apple's own; everything else uses KoolKat's
  // Android (Noto Color Emoji) set so they look the same on every device.
  var apple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  if (!apple) document.documentElement.classList.add('android-emoji');

  // Text style: 'regular' (regular text, semibold headings) or 'semibold'
  // (semibold text, bold headings). Remembered on this device.
  var TEXT_KEY = 'koolkat.text';
  function getText() {
    try {
      return localStorage.getItem(TEXT_KEY) === 'semibold' ? 'semibold' : 'regular';
    } catch (e) {
      return 'regular';
    }
  }
  function applyText(style) {
    if (style === 'semibold') document.documentElement.setAttribute('data-text', 'semibold');
    else document.documentElement.removeAttribute('data-text');
  }
  function setText(style) {
    try {
      if (style === 'semibold') localStorage.setItem(TEXT_KEY, 'semibold');
      else localStorage.removeItem(TEXT_KEY);
    } catch (e) {
      /* storage blocked: the choice lasts for this visit only */
    }
    applyText(style);
  }
  applyText(getText());

  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      apply(get());
    });
  }
  window.koolkatTheme = { get: get, set: set, getText: getText, setText: setText };
})();
