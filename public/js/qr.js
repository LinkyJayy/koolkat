// QR codes for adding friends in person: drawing your own code and scanning
// someone else's with the camera.
import qrcode from '../vendor/qrcode.mjs';

const CODE_RE = /^[A-Za-z0-9_-]{22}$/;

/** The link a friend code QR holds. Opening it in KoolKat adds you as friends. */
export function friendLink(code) {
  return `${location.origin}${location.pathname}#add/${code}`;
}

/** Pull the friend code out of a scanned QR (a KoolKat link or the bare code). */
export function parseFriendCode(text) {
  const value = String(text ?? '').trim();
  if (CODE_RE.test(value)) return value;
  const match = value.match(/#add\/([A-Za-z0-9_-]{22})$/);
  return match ? match[1] : null;
}

/** Draw a QR code for `text` filling the canvas (black on white, with a quiet zone). */
export function drawQr(canvas, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const cells = count + quiet * 2;
  const cell = Math.floor(canvas.width / cells);
  const offset = Math.floor((canvas.width - cell * cells) / 2) + quiet * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(offset + c * cell, offset + r * cell, cell, cell);
    }
  }
}

let jsQrLoading = null;
/** jsQR is only downloaded on browsers without a built-in QR reader. */
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQrLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/jsQR.js', import.meta.url).href;
    script.onload = () => resolve(window.jsQR);
    script.onerror = () => {
      jsQrLoading = null;
      reject(new Error("The QR reader couldn't be loaded. Check your connection."));
    };
    document.head.append(script);
  });
  return jsQrLoading;
}

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video)).map((b) => b.rawValue);
      }
    } catch {
      // Fall back to jsQR below.
    }
  }
  const jsQR = await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    return found ? [found.data] : [];
  };
}

/**
 * Look for QR codes in a playing <video>. Calls onCode(text) for each code
 * seen until it returns true (handled) or stop() is called.
 */
export async function scanVideo(video, onCode) {
  const detect = await makeDetector();
  let stopped = false;
  let busy = false;
  const timer = setInterval(async () => {
    if (stopped || busy || !video.videoWidth) return;
    busy = true;
    try {
      for (const text of await detect(video)) {
        if (stopped) break;
        if (await onCode(text)) {
          stop();
          break;
        }
      }
    } catch {
      // A frame that couldn't be read; try the next one.
    } finally {
      busy = false;
    }
  }, 250);
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
