import crypto from 'node:crypto';

// Small helpers shared by the API route modules.

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => {
  throw new HttpError(status, message);
};

export function base64Field(value, name, { min = 1, max = Infinity } = {}) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    fail(400, `${name} must be base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < min || bytes.length > max) fail(400, `${name} has an invalid length`);
  return bytes;
}

/** Accept only an uncompressed P-256 ECDH public key in SPKI/DER form. */
export function validatePublicKey(value, name = 'publicKey') {
  const der = base64Field(value, name, { max: 200 });
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('wrong curve');
    }
  } catch {
    fail(400, `${name} must be a P-256 public key`);
  }
  return value;
}

export const pair = (a, b) => (a < b ? [a, b] : [b, a]);

export function parseUserId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'Invalid user id');
  return id;
}
