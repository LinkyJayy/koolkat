import { fail } from './http.js';

// Social media links on profiles (anyone can add theirs). Each is stored as a
// link to that site only, so a profile can never link somewhere else.

export const SOCIALS = {
  youtube: { name: 'YouTube', home: 'www.youtube.com', at: true, hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com'] },
  instagram: { name: 'Instagram', home: 'www.instagram.com', at: false, hosts: ['instagram.com', 'www.instagram.com'] },
  tiktok: { name: 'TikTok', home: 'www.tiktok.com', at: true, hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'] },
  facebook: { name: 'Facebook', home: 'www.facebook.com', at: false, hosts: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com'] },
  linktree: { name: 'Linktree', home: 'linktr.ee', at: false, hosts: ['linktr.ee', 'www.linktr.ee'] },
  x: { name: 'X', home: 'x.com', at: false, hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'] },
};
const HANDLE_RE = /^[A-Za-z0-9._-]{1,60}$/;
const PATH_RE = /^\/[A-Za-z0-9._~\-/@%]{1,120}$/;

/**
 * Turn what someone typed (a @handle, a handle, or a link to their page) into a
 * clean https link on that site. '' or null clears it.
 */
export function socialLink(site, value) {
  const spec = SOCIALS[site];
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text) || /^(www\.|m\.)?[a-z]+\.(com|ee)\//i.test(text)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      fail(400, `That isn't a ${spec.name} link`);
    }
    if (!spec.hosts.includes(url.hostname.toLowerCase())) fail(400, `That isn't a ${spec.name} link`);
    const path = url.pathname.replace(/\/+$/, '');
    if (!PATH_RE.test(path)) fail(400, `That isn't a ${spec.name} link`);
    // Facebook profiles without a username: facebook.com/profile.php?id=123
    const id = url.searchParams.get('id');
    if (site === 'facebook' && path === '/profile.php' && /^\d{1,20}$/.test(id ?? '')) return `https://${spec.home}${path}?id=${id}`;
    return `https://${spec.home}${path}`;
  }
  const handle = text.replace(/^@/, '');
  if (!HANDLE_RE.test(handle)) fail(400, `That isn't a ${spec.name} username`);
  return `https://${spec.home}/${spec.at ? '@' : ''}${handle}`;
}

/** The links saved for a user, e.g. { youtube: 'https://www.youtube.com/@kat' }. */
export function socialsOf(u) {
  if (!u?.socials) return {};
  try {
    const saved = JSON.parse(u.socials);
    return Object.fromEntries(Object.entries(saved).filter(([site, url]) => SOCIALS[site] && typeof url === 'string'));
  } catch {
    return {};
  }
}
