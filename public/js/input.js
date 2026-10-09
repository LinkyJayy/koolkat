// Keyboard and game controller support for every menu.
//
// Keyboard: Tab / Shift+Tab, or the arrow keys, move between buttons; Enter or
// Space presses; Esc goes back (or closes what's open).
// Controller: D-pad or a stick moves, A presses, B goes back, LB / RB switch
// tabs (Home, Reels, Camera, Music, Chats).
//
// Moving with the arrows / D-pad picks the nearest button in that direction
// on screen, so it works the same in every menu without per-screen code.

const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
const BACK = '[data-back], #btn-up-back, #btn-music-back, #btn-reels-back, #btn-wordle-back, #btn-camera-close, #btn-kart-exit, #btn-kw-exit';
const DEADZONE = 0.5;
const REPEAT_FIRST = 380;
const REPEAT_NEXT = 130;

const visible = (node) => {
  if (!node || node.closest('[hidden]')) return false;
  if (!node.getClientRects().length) return false;
  const style = getComputedStyle(node);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

/** Where focus can go right now: the open dialog, or the screen with its tab bar and mini player. */
function roots() {
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  if (dialogs.length) return [dialogs.at(-1)];
  // Overlays inside a screen (game results) take over too.
  const overlay = [...document.querySelectorAll('.screen:not([hidden]) [data-modal]')].find((n) => !n.hidden);
  if (overlay) return [overlay];
  return [document.querySelector('.screen:not([hidden])'), document.getElementById('mini-player'), document.getElementById('tabbar')].filter(
    (n) => n && !n.hidden
  );
}

function focusables() {
  return roots()
    .flatMap((root) => [...root.querySelectorAll(FOCUSABLE)])
    .filter((n) => !n.disabled && visible(n));
}

function focus(node) {
  if (!node) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** Move to the nearest button in a direction: 'up', 'down', 'left' or 'right'. */
export function moveFocus(dir) {
  const items = focusables();
  if (!items.length) return;
  const current = document.activeElement;
  if (!items.includes(current)) {
    // Start from the top-left-most one.
    items.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    focus(items[0]);
    return;
  }
  const from = current.getBoundingClientRect();
  const c = center(from);
  let best = null;
  let bestScore = Infinity;
  for (const node of items) {
    if (node === current) continue;
    const r = node.getBoundingClientRect();
    const p = center(r);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    let along;
    let across;
    if (dir === 'right') [along, across] = [r.left - from.right + from.width / 2, dy];
    else if (dir === 'left') [along, across] = [from.left - r.right + from.width / 2, dy];
    else if (dir === 'down') [along, across] = [r.top - from.bottom + from.height / 2, dx];
    else [along, across] = [from.top - r.bottom + from.height / 2, dx];
    const primary = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    if (primary <= 2 || along < -2) continue;
    // Prefer things in the same row (or column), then straight ahead:
    // sideways distance counts double.
    const inLine = dir === 'left' || dir === 'right' ? r.top < from.bottom && r.bottom > from.top : r.left < from.right && r.right > from.left;
    if (!inLine && (dir === 'left' || dir === 'right')) continue; // left/right stay in the row
    const score = Math.max(0, along) + Math.abs(across) * 2 + (inLine ? 0 : 5000);
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  if (best) focus(best);
}

/**
 * After a new screen or dialog opens: if you're using a keyboard or
 * controller, select its first button (not the back button).
 */
export function focusFirst() {
  if (!document.documentElement.classList.contains('kb-nav')) return;
  requestAnimationFrame(() => {
    const items = focusables();
    if (items.includes(document.activeElement)) return;
    const first = items.find((n) => !n.matches(BACK)) ?? items[0];
    focus(first);
  });
}

/** Back: close the open dialog, or press the screen's back button. */
export function goBack() {
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (dialog) {
    dialog.close();
    return true;
  }
  const button = [...document.querySelectorAll(BACK)].find((b) => visible(b) && b.closest('.screen:not([hidden])'));
  if (button) {
    button.click();
    return true;
  }
  return false;
}

function cycleTabs(step) {
  const bar = document.getElementById('tabbar');
  if (!bar || bar.hidden || document.querySelector('dialog[open]')) return;
  const tabs = [...bar.querySelectorAll('.tab-btn')];
  let i = tabs.findIndex((t) => t.classList.contains('active'));
  if (i < 0) i = 0;
  const next = tabs[(i + step + tabs.length) % tabs.length];
  next.click();
}

const markKeyboard = () => document.documentElement.classList.add('kb-nav');

/**
 * Turn it on. `busy()` says when a game wants the arrows / D-pad itself
 * (Kat Kart while racing), so menus don't move.
 */
export function initInput({ busy = () => false } = {}) {
  document.addEventListener('pointerdown', () => document.documentElement.classList.remove('kb-nav'), true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') markKeyboard();
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    const typing = target.closest?.('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return; // the browser closes dialogs itself
      if (goBack()) e.preventDefault();
      return;
    }
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (!dir || busy()) return;
    if (typing) {
      // Left/right move the cursor in text and slide sliders; up/down leave the box.
      if (dir === 'left' || dir === 'right' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    }
    markKeyboard();
    e.preventDefault();
    moveFocus(dir);
  });

  // ---------- game controllers ----------
  const held = new Map(); // control -> { since, last }
  let polling = false;

  function press(control, now, action, repeat = true) {
    const h = held.get(control);
    if (!h) {
      held.set(control, { since: now, last: now });
      action();
    } else if (repeat && now - h.since > REPEAT_FIRST && now - h.last > REPEAT_NEXT) {
      h.last = now;
      action();
    }
  }

  function poll() {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
    if (!pads.length) {
      polling = false;
      return;
    }
    const now = performance.now();
    const down = new Set();
    for (const pad of pads) {
      const b = (i) => pad.buttons[i]?.pressed;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (b(12) || ay < -DEADZONE) down.add('up');
      if (b(13) || ay > DEADZONE) down.add('down');
      if (b(14) || ax < -DEADZONE) down.add('left');
      if (b(15) || ax > DEADZONE) down.add('right');
      if (b(0)) down.add('a');
      if (b(1)) down.add('b');
      if (b(4)) down.add('lb');
      if (b(5)) down.add('rb');
      if (b(9)) down.add('start');
    }
    const game = busy();
    for (const control of down) {
      if (['up', 'down', 'left', 'right'].includes(control)) {
        if (game) continue;
        press(control, now, () => {
          markKeyboard();
          moveFocus(control);
        });
      } else if (control === 'a') {
        if (game) continue;
        press(control, now, () => {
          markKeyboard();
          const items = focusables();
          if (items.includes(document.activeElement)) document.activeElement.click();
          else moveFocus('down');
        }, false);
      } else if (control === 'b' || control === 'start') {
        press(control, now, () => {
          if (game && control === 'b') document.getElementById('btn-kart-quit')?.dispatchEvent(new CustomEvent('gamepad-quit'));
          else if (!game) goBack();
        }, false);
      } else if (control === 'lb' || control === 'rb') {
        if (game) continue;
        press(control, now, () => cycleTabs(control === 'rb' ? 1 : -1), false);
      }
    }
    for (const control of [...held.keys()]) if (!down.has(control)) held.delete(control);
    requestAnimationFrame(poll);
  }

  const start = () => {
    if (polling) return;
    polling = true;
    requestAnimationFrame(poll);
  };
  window.addEventListener('gamepadconnected', start);
  // A controller that was already connected shows up after its first button press.
  if ([...(navigator.getGamepads?.() ?? [])].some(Boolean)) start();
}

/** Steering from any controller: D-pad, left stick or right stick, from -1 (left) to 1 (right). */
export function gamepadSteer() {
  let steer = 0;
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad) continue;
    if (pad.buttons[14]?.pressed) steer = -1;
    else if (pad.buttons[15]?.pressed) steer = 1;
    else {
      for (const i of [0, 2]) {
        const v = pad.axes[i] ?? 0;
        if (Math.abs(v) > 0.2 && Math.abs(v) > Math.abs(steer)) steer = Math.max(-1, Math.min(1, (v - Math.sign(v) * 0.2) / 0.8));
      }
    }
  }
  return steer;
}

/**
 * A game button (a power-up, a Mouse) that works the moment a finger lands
 * on it, even while other fingers are holding the screen (phones often don't
 * send a "click" then). Keyboard Enter / Space and mouse clicks still work.
 */
export function onPress(button, action) {
  if (!button) return;
  let pressedAt = 0;
  button.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // don't steer / swipe / shoot with this finger
    pressedAt = performance.now();
    action();
  });
  button.addEventListener('click', () => {
    // Already handled on pointerdown (the click that follows a tap).
    if (performance.now() - pressedAt < 800) return;
    action();
  });
}
