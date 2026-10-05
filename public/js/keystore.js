// Keeps the unlocked (non-extractable) private key in IndexedDB so you stay
// signed in across reloads without re-entering your password. A non-extractable
// CryptoKey can be stored and used, but its raw bytes can't be read back out.

const DB_NAME = 'koolkat';
const STORE = 'keys';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveIdentity(identity) {
  try {
    await run('readwrite', (s) => s.put(identity, 'identity'));
  } catch {
    /* private browsing etc.: you'll just need to sign in again next time */
  }
}

export async function loadIdentity() {
  try {
    return (await run('readonly', (s) => s.get('identity'))) ?? null;
  } catch {
    return null;
  }
}

export async function clearIdentity() {
  try {
    await run('readwrite', (s) => s.delete('identity'));
  } catch {
    /* nothing stored */
  }
}
