// KoolKat's sounds:
//   koolkat_notification.wav: a new Klick, message or friend request (while KoolKat is open)
//   koolkat_calling.wav:      ringing, when you call someone and when a Call or FaceTime comes in
//
// Phones play their own sound for push notifications when KoolKat is closed;
// websites can't choose that sound.

const FILES = {
  notification: 'sounds/koolkat_notification.wav',
  calling: 'sounds/koolkat_calling.wav',
};
const PREF_KEY = 'koolkat.sounds';
const players = {};

function player(name) {
  if (!players[name]) {
    players[name] = new Audio(FILES[name]);
    players[name].preload = 'auto';
  }
  return players[name];
}

/** Whether the notification sound is on (calls always ring). */
export function soundsOn() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsOn(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    // Remembering it is only a convenience.
  }
}

export function playNotification() {
  if (!soundsOn()) return;
  const audio = player('notification');
  audio.loop = false;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

let ringing = false;

export function startRinging() {
  ringing = true;
  const audio = player('calling');
  audio.loop = true;
  audio.currentTime = 0;
  audio.play().catch(() => {});
  // Buzz too, where phones allow it.
  navigator.vibrate?.([400, 200, 400, 1000]);
}

export function stopRinging() {
  ringing = false;
  const audio = players.calling;
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  navigator.vibrate?.(0);
}

// Browsers only allow sound after you've touched the page, so the first tap
// quietly "unlocks" both sounds for later.
function unlock() {
  for (const name of Object.keys(FILES)) {
    const audio = player(name);
    if (name === 'calling' && ringing) continue;
    audio.muted = true;
    audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
      })
      .catch(() => {})
      .finally(() => {
        audio.muted = false;
        if (name === 'calling' && ringing) startRinging();
      });
  }
}
document.addEventListener('pointerdown', unlock, { once: true, capture: true });
