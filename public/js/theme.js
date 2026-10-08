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

  // Accent colour (KoolKat Unlimited): replaces KoolKat blue on buttons, tabs
  // and highlights. Saved on the account; remembered here so it shows straight away.
  var ACCENT_KEY = 'koolkat.accent';
  function normaliseHex(value) {
    var hex = String(value || '').trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(hex)) hex = hex.replace(/./g, '$&$&');
    return /^[0-9a-f]{6}$/.test(hex) ? '#' + hex : null;
  }
  function applyAccent(value) {
    var style = document.documentElement.style;
    var hex = normaliseHex(value);
    if (!hex) {
      ['--brand', '--brand-2', '--brand-soft', '--brand-ink'].forEach(function (name) {
        style.removeProperty(name);
      });
      return;
    }
    var n = parseInt(hex.slice(1), 16);
    var r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    var light = function (c) { return Math.round(c + (255 - c) * 0.35); };
    // Dark text on light accents (yellow, mint…), white on the rest.
    var lin = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    style.setProperty('--brand', hex);
    style.setProperty('--brand-2', 'rgb(' + light(r) + ', ' + light(g) + ', ' + light(b) + ')');
    style.setProperty('--brand-soft', 'rgba(' + r + ', ' + g + ', ' + b + ', 0.16)');
    style.setProperty('--brand-ink', luminance > 0.45 ? '#0f172a' : '#ffffff');
  }
  function getAccent() {
    try {
      return normaliseHex(localStorage.getItem(ACCENT_KEY));
    } catch (e) {
      return null;
    }
  }
  function setAccent(value) {
    var hex = normaliseHex(value);
    try {
      if (hex) localStorage.setItem(ACCENT_KEY, hex);
      else localStorage.removeItem(ACCENT_KEY);
    } catch (e) {
      /* storage blocked: it still applies after signing in */
    }
    applyAccent(hex);
  }
  applyAccent(getAccent());

  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      apply(get());
    });
  }
  window.koolkatTheme = {
    get: get,
    set: set,
    getText: getText,
    setText: setText,
    getAccent: getAccent,
    setAccent: setAccent,
    normaliseHex: normaliseHex,
  };
})();
