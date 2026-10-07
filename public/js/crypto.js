// KoolKat end-to-end encryption. Runs entirely on the user's device using the
// Web Crypto API; the server only ever sees public keys and ciphertext.
//
// Keys
//   - Every account has a P-256 ECDH identity key pair, generated on the device.
//   - The password is stretched with PBKDF2 into 512 bits: the first half is the
//     "auth secret" sent to the server to log in, the second half is a local
//     AES-GCM key that encrypts the identity private key before it is uploaded.
//     The server can't derive one half from the other, so it can never unlock
//     the private key (this lets you sign in from a new device).
//
// Snaps
//   - The photo + caption are encrypted with a fresh random AES-256-GCM key.
//   - A fresh ephemeral ECDH key pair is made for each snap. For every friend
//     receiving it, ECDH(ephemeral, friend's public key) -> HKDF -> wrapping
//     key, which encrypts the snap key. Only that friend's private key can
//     recover it.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

// ---------- encoding helpers ----------
export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const toHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// ---------- password-derived keys ----------
export async function deriveKeysFromPassword(username, password, iterations = PBKDF2_ITERATIONS) {
  const material = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`koolkat-v1:${username.toLowerCase()}`), iterations },
      material,
      512
    )
  );
  const authSecret = toHex(bits.slice(0, 32));
  const vaultKey = await subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { authSecret, vaultKey };
}

// ---------- identity keys ----------
/** Make a new identity key pair and encrypt the private half with the vault key. */
export async function createIdentity(vaultKey) {
  const pair = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const publicKey = toBase64(await subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  const iv = randomBytes(12);
  const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, pkcs8);
  return {
    publicKey,
    encryptedPrivateKey: toBase64(sealed),
    privateKeyIv: toBase64(iv),
    privateKey: await importPrivateKey(pkcs8),
  };
}

/** Decrypt the uploaded private key. Throws if the password was wrong. */
export async function unlockIdentity(vaultKey, encryptedPrivateKey, privateKeyIv) {
  const pkcs8 = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(privateKeyIv) },
    vaultKey,
    fromBase64(encryptedPrivateKey)
  );
  return importPrivateKey(pkcs8);
}

// Re-imported as non-extractable: page scripts can use it but never read it out.
const importPrivateKey = (pkcs8) => subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
const importPublicKey = (b64) => subtle.importKey('spki', fromBase64(b64), CURVE, false, []);

/** Short human-comparable fingerprint of a public key, e.g. "3f2a 91c0 ...". */
export async function fingerprint(publicKeyB64) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', fromBase64(publicKeyB64)));
  return toHex(digest.slice(0, 12)).match(/.{4}/g).join(' ');
}

// ---------- snap encryption ----------
// `context` keeps keys for different kinds of data (Klicks, messages) separate.
async function wrappingKey(privateKey, publicKey, recipientId, context = 'snap') {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(`koolkat-${context}:${recipientId}`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a photo and its caption for a list of friends.
 * @param {Uint8Array} imageBytes  JPEG bytes
 * @param {{caption?: string, captionY?: number, mime?: string}} meta
 * @param {{userId: number, publicKey: string}[]} recipients
 * @param {{userId: number, publicKey: string}} [sender]  also wrap the key for the
 *        sender, so they can view their own snap later
 */
export async function encryptSnap(imageBytes, meta, recipients, sender) {
  const metaBytes = enc.encode(
    JSON.stringify({ caption: meta.caption ?? '', captionY: meta.captionY ?? 0.5, mime: meta.mime ?? 'image/jpeg' })
  );
  // Plaintext layout: [4-byte big-endian meta length][meta JSON][image bytes]
  const plain = new Uint8Array(4 + metaBytes.length + imageBytes.length);
  new DataView(plain.buffer).setUint32(0, metaBytes.length);
  plain.set(metaBytes, 4);
  plain.set(imageBytes, 4 + metaBytes.length);

  const snapKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = randomBytes(12);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, snapKey, plain);
  const rawSnapKey = await subtle.exportKey('raw', snapKey);

  const ephemeral = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const wrapFor = async ({ userId, publicKey }) => {
    const key = await wrappingKey(ephemeral.privateKey, await importPublicKey(publicKey), userId);
    const wrapIv = randomBytes(12);
    const wrappedKey = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, key, rawSnapKey);
    return { userId, wrappedKey: toBase64(wrappedKey), wrapIv: toBase64(wrapIv) };
  };
  const wrapped = await Promise.all(recipients.map(wrapFor));
  const own = sender ? await wrapFor(sender) : null;

  return {
    iv: toBase64(iv),
    ephemeralPublicKey: toBase64(await subtle.exportKey('spki', ephemeral.publicKey)),
    ciphertext: toBase64(ciphertext),
    recipients: wrapped,
    ...(own ? { senderWrappedKey: own.wrappedKey, senderWrapIv: own.wrapIv } : {}),
  };
}

/** Decrypt a snap addressed to `myUserId`. Returns {imageBytes, caption, captionY, mime}. */
export async function decryptSnap(snap, privateKey, myUserId) {
  const key = await wrappingKey(privateKey, await importPublicKey(snap.ephemeralPublicKey), myUserId);
  const rawSnapKey = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(snap.wrapIv) }, key, fromBase64(snap.wrappedKey));
  const snapKey = await subtle.importKey('raw', rawSnapKey, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(snap.iv) }, snapKey, fromBase64(snap.ciphertext))
  );
  const metaLength = new DataView(plain.buffer).getUint32(0);
  const meta = JSON.parse(dec.decode(plain.subarray(4, 4 + metaLength)));
  return {
    imageBytes: plain.slice(4 + metaLength),
    caption: typeof meta.caption === 'string' ? meta.caption : '',
    captionY: Number.isFinite(meta.captionY) ? Math.min(Math.max(meta.captionY, 0.05), 0.95) : 0.5,
    mime: meta.mime === 'image/png' ? 'image/png' : 'image/jpeg',
  };
}

// ---------- chat messages ----------
// Same scheme as Klicks: a fresh AES-256-GCM key per message, wrapped for
// every chat member (including the sender) with ECDH + HKDF.

/** Encrypt a text message for chat members. Returns the body for POST /chats/:id/messages. */
export async function encryptMessage(text, members) {
  const messageKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = randomBytes(12);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, messageKey, enc.encode(JSON.stringify({ text })));
  const rawKey = await subtle.exportKey('raw', messageKey);
  const ephemeral = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const keys = await Promise.all(
    members.map(async ({ userId, publicKey }) => {
      const key = await wrappingKey(ephemeral.privateKey, await importPublicKey(publicKey), userId, 'message');
      const wrapIv = randomBytes(12);
      const wrappedKey = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, key, rawKey);
      return { userId, wrappedKey: toBase64(wrappedKey), wrapIv: toBase64(wrapIv) };
    })
  );
  return {
    iv: toBase64(iv),
    ephemeralPublicKey: toBase64(await subtle.exportKey('spki', ephemeral.publicKey)),
    ciphertext: toBase64(ciphertext),
    keys,
  };
}

/** Decrypt a message from GET /chats/:id/messages. Returns the text. */
export async function decryptMessage(message, privateKey, myUserId) {
  const key = await wrappingKey(privateKey, await importPublicKey(message.ephemeralPublicKey), myUserId, 'message');
  const rawKey = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(message.wrapIv) }, key, fromBase64(message.wrappedKey));
  const messageKey = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(message.iv) }, messageKey, fromBase64(message.ciphertext));
  const { text } = JSON.parse(dec.decode(plain));
  return typeof text === 'string' ? text : '';
}

// ---------- calls ----------
// Call audio and video are encrypted by WebRTC itself (DTLS-SRTP). The messages
// that set a call up travel through the server, so they're encrypted too, with
// a key only the two friends can work out: ECDH(my identity key, their identity
// key) -> HKDF, bound to this call. The server can't read or forge them, so it
// can't put itself in the middle of the call.

/** The AES-GCM key for one call's setup messages. Both friends get the same key. */
export async function callKey(privateKey, peerPublicKeyB64, callId, callerId, calleeId) {
  const shared = await subtle.deriveBits({ name: 'ECDH', public: await importPublicKey(peerPublicKeyB64) }, privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: enc.encode(`koolkat-call:${callId}:${callerId}:${calleeId}`),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt a call setup message. `fromUserId` is bound in, so a message can't be bounced back to its sender. */
export async function sealSignal(key, message, fromUserId) {
  const iv = randomBytes(12);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`from:${fromUserId}`) },
    key,
    enc.encode(JSON.stringify(message))
  );
  return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

/** Decrypt a call setup message from `fromUserId`. Throws if it was tampered with. */
export async function openSignal(key, data, fromUserId) {
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(data.iv), additionalData: enc.encode(`from:${fromUserId}`) },
    key,
    fromBase64(data.ciphertext)
  );
  return JSON.parse(dec.decode(plain));
}
