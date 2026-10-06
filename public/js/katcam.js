// KatCam: one Klick from both cameras, the main camera full size with the
// other one in the corner.

/** Wait until a <video> is showing frames (or give up after `timeout` ms). */
export function waitForPicture(video, timeout = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (video.videoWidth && video.readyState >= 2) resolve(true);
      else if (Date.now() - started > timeout) resolve(false);
      else setTimeout(check, 50);
    };
    check();
  });
}

/** Copy the current frame of a video onto a new canvas (at most `max` pixels on the long side). */
export function grabFrame(video, { mirror = false, max = 1440 } = {}) {
  const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d');
  if (mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Put `inset` in the top-left corner of `main`, with a white border and rounded corners. */
export function compose(main, inset) {
  const canvas = document.createElement('canvas');
  canvas.width = main.width;
  canvas.height = main.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(main, 0, 0);

  const short = Math.min(main.width, main.height);
  const w = Math.round(short * 0.34);
  const h = Math.round((w * inset.height) / inset.width);
  const margin = Math.round(short * 0.04);
  const border = Math.max(3, Math.round(short * 0.01));
  const radius = Math.round(w * 0.12);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = border * 3;
  ctx.fillStyle = '#fff';
  roundedRect(ctx, margin - border, margin - border, w + border * 2, h + border * 2, radius + border);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRect(ctx, margin, margin, w, h, radius);
  ctx.clip();
  ctx.drawImage(inset, margin, margin, w, h);
  ctx.restore();
  return canvas;
}

/** Ask for one camera ('user' or 'environment'), trying simpler requests if the first fails. */
export async function openCamera(facing, { exact = false } = {}) {
  const facingMode = exact ? { exact: facing } : { ideal: facing };
  const attempts = [{ facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, { facingMode }];
  let error;
  for (const video of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch (err) {
      error = err;
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') break;
    }
  }
  throw error;
}

export const stopStream = (stream) => stream?.getTracks().forEach((t) => t.stop());
