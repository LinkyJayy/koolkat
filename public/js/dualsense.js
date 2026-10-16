// A PS5 DualSense (or DualSense Edge) controller's motion sensor, for steering
// by tilting the controller like a wheel. Browsers' Gamepad API doesn't pass
// motion on, so this talks to the controller directly with WebHID (Chrome and
// Edge on a computer; you pick the controller once, then it's remembered).
//
// The input report (from Linux's hid-playstation driver): over USB it's report
// 0x01, over Bluetooth 0x31 with one extra byte at the start. After the sticks,
// triggers, buttons and 4 spare bytes come the gyro (x, y, z) and then the
// accelerometer (x, y, z), each a little-endian int16.

const SONY = 0x054c;
const MODELS = [0x0ce6, 0x0df2]; // DualSense, DualSense Edge
const ACCEL_USB = 21; // where the accelerometer starts (report 0x01, USB)
const ACCEL_BT = 22; // report 0x31 (Bluetooth)

export const dualSenseSupported = () => typeof navigator !== 'undefined' && 'hid' in navigator;

export function createDualSense() {
  const ds = {
    device: null,
    via: null, // 'USB' | 'Bluetooth'
    lean: 0, // sideways tilt, as the sine of the angle (-1 to 1); right side down is positive
    seenAt: 0,
    listeners: new Set(),
    onChange(fn) {
      ds.listeners.add(fn);
    },
    get connected() {
      return Boolean(ds.device?.opened) && performance.now() - ds.seenAt < 1000;
    },
  };
  const changed = () => ds.listeners.forEach((fn) => fn(ds));

  function onReport(e) {
    const v = e.data;
    let at;
    if (e.reportId === 0x01 && v.byteLength >= ACCEL_USB + 6) {
      at = ACCEL_USB;
      ds.via ??= 'USB';
    } else if (e.reportId === 0x31 && v.byteLength >= ACCEL_BT + 6) {
      at = ACCEL_BT;
      ds.via = 'Bluetooth';
    } else return; // Bluetooth's short report has no motion (we ask for the full one when connecting)
    const ax = v.getInt16(at, true);
    const ay = v.getInt16(at + 2, true);
    const az = v.getInt16(at + 4, true);
    const g = Math.hypot(ax, ay, az);
    if (g < 1) return;
    // Gravity's sideways share: how far the controller is turned, like a steering wheel
    // (held flat or upright, it's the same).
    ds.lean = Math.max(-1, Math.min(1, -ax / g));
    const was = ds.seenAt;
    ds.seenAt = performance.now();
    if (!was) changed();
  }

  async function use(device) {
    if (!device) return false;
    try {
      if (!device.opened) await device.open();
      // Over Bluetooth, reading the calibration (feature report 5) switches it to full reports with motion.
      await device.receiveFeatureReport(0x05).catch(() => {});
      if (ds.device && ds.device !== device) ds.device.removeEventListener('inputreport', onReport);
      device.addEventListener('inputreport', onReport);
      ds.device = device;
      ds.via = null;
      ds.seenAt = 0;
      changed();
      return true;
    } catch {
      return false;
    }
  }

  /** Pick the controller (from a tap: the browser shows a list). */
  async function connect() {
    if (!dualSenseSupported()) throw new Error('Controller motion needs Chrome or Edge on a computer');
    const [device] = await navigator.hid.requestDevice({ filters: MODELS.map((productId) => ({ vendorId: SONY, productId })) });
    if (!device) return false;
    if (!(await use(device))) throw new Error("Couldn't connect to the controller. Is another app using it?");
    return true;
  }

  async function disconnect() {
    const d = ds.device;
    ds.device = null;
    ds.seenAt = 0;
    ds.lean = 0;
    if (d) {
      d.removeEventListener('inputreport', onReport);
      await d.close().catch(() => {});
    }
    changed();
  }

  // A controller picked before connects by itself (when it's plugged in or paired).
  if (dualSenseSupported()) {
    navigator.hid
      .getDevices()
      .then((list) => use(list.find((d) => d.vendorId === SONY && MODELS.includes(d.productId))))
      .catch(() => {});
    navigator.hid.addEventListener('connect', (e) => {
      if (!ds.device && e.device.vendorId === SONY && MODELS.includes(e.device.productId)) use(e.device);
    });
    navigator.hid.addEventListener('disconnect', (e) => {
      if (e.device === ds.device) {
        ds.device = null;
        ds.seenAt = 0;
        ds.lean = 0;
        changed();
      }
    });
  }

  return Object.assign(ds, { connect, disconnect });
}
