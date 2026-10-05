const TOKEN_KEY = 'koolkat.token';

// Empty when the backend serves this page; set in js/config.js otherwise.
export const API_BASE = String(window.KOOLKAT_CONFIG?.apiUrl || '').replace(/\/+$/, '');

let onUnauthorized = () => {};

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session just won't survive a reload */
  }
}

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout?.(20000),
    });
  } catch (err) {
    throw new Error(
      err?.name === 'TimeoutError'
        ? 'KoolKat took too long to respond. Check your connection and try again.'
        : "Can't reach KoolKat. Check your connection."
    );
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}
