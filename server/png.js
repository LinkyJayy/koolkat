import zlib from 'node:zlib';

// Just enough PNG to recolour KoolKat's own icons: reads 8-bit RGB/RGBA
// (non-interlaced) and writes RGBA.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** { width, height, data } with data as RGBA bytes. */
export function decodePng(file) {
  if (!file.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
  let offset = 8;
  let header;
  const idat = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const { width, height, depth, color, interlace } = header ?? {};
  const channels = { 2: 3, 6: 4 }[color];
  if (depth !== 8 || !channels || interlace) throw new Error('Unsupported PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[out + x] = value & 255;
    }
  }
  if (channels === 4) return { width, height, data: pixels };
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    data[j] = pixels[i];
    data[j + 1] = pixels[i + 1];
    data[j + 2] = pixels[i + 2];
    data[j + 3] = 255;
  }
  return { width, height, data };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Swap KoolKat blue for another colour. The icon is drawn in blue, white and
 * black, so each pixel is split into those three (edges are mixes of them)
 * and rebuilt with the new colour in place of blue.
 */
export function recolourKoolKatBlue(image, hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const [nr, ng, nb] = [n >> 16, (n >> 8) & 255, n & 255];
  const data = Buffer.from(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const white = data[i] / 255;
    const blue = Math.max(0, Math.min(1, data[i + 2] / 255 - white));
    if (blue < 0.02) continue;
    data[i] = Math.round(blue * nr + white * 255);
    data[i + 1] = Math.round(blue * ng + white * 255);
    data[i + 2] = Math.round(blue * nb + white * 255);
  }
  return { ...image, data };
}
