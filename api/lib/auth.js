import { neonSQL } from './neon.js';

export function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [key, ...rest] = c.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

export function getAuthFromCookie(req) {
  const c = parseCookies(req);
  if (c.pc_auth) {
    const parts = c.pc_auth.split('|');
    // New format: userId|email|sv|ts|token
    if (parts.length === 5) {
      const [uid, e, sv, t, tk] = parts;
      if (uid && e && sv && t && tk) return { userId: uid, email: e, sv, ts: t, token: tk };
    }
    // Legacy format: email|ts|token (auto-expires within 4hr)
    if (parts.length === 3) {
      const [e, t, tk] = parts;
      if (e && t && tk) return { userId: '', email: e, sv: '', ts: t, token: tk };
    }
  }
  return null;
}

// Extract all auth fields from cookie (or header fallback)
export function extractAuth(req) {
  const authCk = getAuthFromCookie(req);
  return {
    userId: authCk?.userId || '',
    email: (authCk?.email || '').toLowerCase().trim(),
    sv: authCk?.sv || '',
    ts: authCk?.ts || '',
    token: authCk?.token || '',
  };
}

export function getProFromCookie(req) {
  const c = parseCookies(req);
  if (c.pc_pro) {
    const parts = c.pc_pro.split('|');
    // New format: userId|email|ts|token
    if (parts.length === 4) {
      const [uid, e, t, tk] = parts;
      if (uid && e && t && tk) return { userId: uid, email: e, ts: t, token: tk };
    }
    // Legacy format: email|ts|token (auto-expires within 4hr)
    if (parts.length === 3) {
      const [e, t, tk] = parts;
      if (e && t && tk) return { userId: '', email: e, ts: t, token: tk };
    }
  }
  return null;
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const maxLen = Math.max(a.length, b.length);
  const aPad = a.padEnd(maxLen, '\0');
  const bPad = b.padEnd(maxLen, '\0');
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    mismatch |= aPad.charCodeAt(i) ^ bPad.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function verifyAuthToken(email, token, timestamp, userId, sessionVersion) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400 || ts - now > 300) return false;

  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );

  // New format: auth:userId:email:sv:ts (bound to user identity + session version)
  if (userId && sessionVersion) {
    const sig = await crypto.subtle.sign('HMAC', key,
      encoder.encode(`auth:${userId}:${email.toLowerCase().trim()}:${sessionVersion}:${ts}`));
    const expected = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (!timingSafeEqual(token, expected)) return false;

    // Re-check session_version from DB to enable instant revocation on logout
    try {
      const rows = await neonSQL('SELECT session_version FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) return false;
      const dbSv = String(rows[0].session_version || 1);
      if (dbSv !== sessionVersion) return false;
    } catch {
      // If DB is unreachable, fail closed (deny access)
      return false;
    }
    return true;
  }

  // Legacy format: auth:email:ts (backwards-compatible, auto-expires within 4hr)
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`auth:${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(token, expected);
}

export async function verifyProToken(userId, email, token, timestamp) {
  if (!email || !token || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp);
  if (isNaN(ts) || now - ts > 14400 || ts - now > 300) return false;

  const secret = process.env.PRO_TOKEN_SECRET;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );

  // New format: userId:email:ts (bound to user identity)
  if (userId) {
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${userId}:${email.toLowerCase().trim()}:${ts}`));
    const expected = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return timingSafeEqual(token, expected);
  }

  // Legacy format: email:ts (backwards-compatible, auto-expires within 4hr)
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${email.toLowerCase().trim()}:${ts}`));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(token, expected);
}
