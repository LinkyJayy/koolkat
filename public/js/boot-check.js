// Runs before the main app. If the app crashes or gets stuck while starting,
// this replaces the endless loading screen with the actual error, so problems
// on a particular phone or browser can be reported instead of guessed at.
(function () {
  var errors = [];
  window.__koolkatErrors = errors;
  window.__koolkatBootStep = 'loading scripts';

  window.addEventListener('error', function (e) {
    errors.push((e.message || 'Script error') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    errors.push('Unhandled: ' + (r && (r.name ? r.name + ': ' : '') + (r && r.message ? r.message : String(r))));
  });

  setTimeout(function () {
    if (window.__koolkatBooted) return;
    var screen = document.getElementById('screen-loading');
    if (!screen || screen.hidden) return;
    var box = document.createElement('div');
    box.className = 'boot-error';
    var title = document.createElement('p');
    title.textContent = "KoolKat couldn't start.";
    var detail = document.createElement('p');
    detail.className = 'fineprint';
    detail.textContent =
      'Stuck at: ' + window.__koolkatBootStep + (errors.length ? ' — ' + errors.join(' | ') : '') + ' — ' + navigator.userAgent;
    var reload = document.createElement('button');
    reload.className = 'btn primary';
    reload.textContent = 'Reload';
    reload.onclick = function () { location.reload(); };
    box.append(title, detail, reload);
    screen.append(box);
  }, 10000);
})();
