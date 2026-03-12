import * as jose from 'jose';
import { getAllowedOrigin, setSecurityHeaders, checkBodySize } from './lib/cors.js';
import { extractAuth, verifyAuthToken } from './lib/auth.js';
import { neonSQL } from './lib/neon.js';
import { checkRateLimit } from './lib/rate-limit.js';

// ── GOOGLE JWKS (cached) ────────────────────────────────
const GOOGLE_JWKS = jose.createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// ── APPLE JWKS (cached) ─────────────────────────────────
const APPLE_JWKS = jose.createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

// ── ROUTER ──────────────────────────────────────────────
export default async function handler(req, res) {
  const action = req.query._action || 'google';
  switch (action) {
    case 'google': return handleGoogle(req, res);
    case 'apple': return handleApple(req, res);
    case 'signout': return handleSignout(req, res);
    case 'delete-account': return handleDeleteAccount(req, res);
    default: return res.status(400).json({ error: 'Unknown action' });
  }
}

// ════════════════════════════════════════════════════════
// GOOGLE AUTH (was api/auth.js)
// ════════════════════════════════════════════════════════
async function handleGoogle(req, res) {
  if (!GOOGLE_CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }
  // ── CORS with origin allowlist ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  // ── Rate limit by IP ──
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'auth', 20)) {
    return res.status(429).json({ error: 'Too many authentication attempts' });
  }

  const { credential, code } = req.body;

  let googleId, email, name, picture;
  let rawIdToken = null; // For iOS native relay

  try {
    if (code) {
      // Authorization code flow (iOS) — exchange code for tokens
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET not configured');

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: clientSecret,
          redirect_uri: process.env.APP_URL || 'http://localhost:3000',
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.id_token) {
        console.error('Code exchange failed:', tokenData);
        return res.status(400).json({ error: 'Code exchange failed' });
      }
      rawIdToken = tokenData.id_token;

      // Verify the exchanged ID token
      const { payload } = await jose.jwtVerify(rawIdToken, GOOGLE_JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: GOOGLE_CLIENT_ID,
      });
      if (!payload.sub || !payload.email) {
        return res.status(401).json({ error: 'Token missing user info' });
      }
      googleId = payload.sub;
      email = payload.email;
      name = payload.name || payload.email;
      picture = payload.picture || '';

    } else if (credential) {
      // GIS credential flow (web) — verify ID token directly
      const { payload } = await jose.jwtVerify(credential, GOOGLE_JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: GOOGLE_CLIENT_ID,
      });

      if (!payload.sub || !payload.email) {
        return res.status(401).json({ error: 'Token missing user info' });
      }
      googleId = payload.sub;
      email = payload.email;
      name = payload.name || payload.email;
      picture = payload.picture || '';
    } else {
      return res.status(400).json({ error: 'No credential provided' });
    }

    const users = await neonSQL(
      `INSERT INTO users (google_id, email, name, picture, last_login)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (google_id) DO UPDATE SET last_login = NOW(), name = $3, picture = $4
       RETURNING id, email, name, picture, COALESCE(session_version, 1) AS session_version`,
      [googleId, email, name, picture]
    );

    const user = users[0];
    const sv = String(user.session_version || 1);

    // Generate HMAC-signed auth token (4hr expiry)
    // Bound to userId + email + session_version to prevent identity confusion and enable revocation
    const authTs = Math.floor(Date.now() / 1000);
    const secret = process.env.AUTH_TOKEN_SECRET;
    if (!secret) throw new Error('AUTH_TOKEN_SECRET not configured');
    const enc = new TextEncoder();
    const authKey = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const authSig = await crypto.subtle.sign(
      'HMAC', authKey,
      enc.encode(`auth:${user.id}:${email.toLowerCase().trim()}:${sv}:${authTs}`)
    );
    const authToken = Array.from(new Uint8Array(authSig))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Set HttpOnly auth cookie (format: userId|email|sv|ts|token)
    const cookieVal = encodeURIComponent(`${user.id}|${email.toLowerCase().trim()}|${sv}|${authTs}|${authToken}`);
    const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
    res.setHeader('Set-Cookie', `pc_auth=${cookieVal}; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=14400`);

    res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture },
      ...(rawIdToken && { idToken: rawIdToken }),
    });
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

// ════════════════════════════════════════════════════════
// APPLE AUTH (was api/auth-apple.js)
// ════════════════════════════════════════════════════════
async function handleApple(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  // ── Rate limit ──
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'auth-apple', 20)) {
    return res.status(429).json({ error: 'Too many authentication attempts' });
  }

  const { id_token, nonce: rawNonce, user: appleUser } = req.body;

  if (!id_token) {
    return res.status(400).json({ error: 'No id_token provided' });
  }

  try {
    // Verify Apple id_token JWT against Apple's public keys
    // Accept both Service ID (web Sign-in) and Bundle ID (iOS native Sign-in)
    const validAudiences = [process.env.APPLE_SERVICE_ID, process.env.APPLE_BUNDLE_ID].filter(Boolean);
    const { payload } = await jose.jwtVerify(id_token, APPLE_JWKS, {
      issuer: 'https://appleid.apple.com',
      audience: validAudiences,
    });

    const appleId = payload.sub;
    const email = payload.email;

    if (!appleId || !email) {
      return res.status(401).json({ error: 'Token missing user info' });
    }

    // Verify nonce to prevent replay attacks
    // Nonce is mandatory for native app builds (iOS), optional for web Sign-in with Apple
    const isNativeApp = (req.headers['user-agent'] || '').includes('pcompass-ios');
    if (isNativeApp && (!rawNonce || !payload.nonce)) {
      return res.status(401).json({ error: 'Nonce required for native app authentication' });
    }
    if (rawNonce && payload.nonce) {
      const enc = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(rawNonce));
      const expectedNonce = Array.from(new Uint8Array(hashBuf), b => b.toString(16).padStart(2, '0')).join('');
      if (payload.nonce !== expectedNonce) {
        return res.status(401).json({ error: 'Nonce mismatch — possible replay' });
      }
    }

    // Apple requires email_verified check
    if (payload.email_verified === false || payload.email_verified === 'false') {
      return res.status(401).json({ error: 'Unverified email' });
    }

    // Name is only sent on first sign-in (from the user object, not the JWT)
    let name = email.split('@')[0];
    if (appleUser && appleUser.name) {
      const first = appleUser.name.firstName || '';
      const last = appleUser.name.lastName || '';
      name = (first + ' ' + last).trim() || name;
    }

    // Upsert user — try apple_id first, then fall back to email match.
    // This avoids edge cases where two Apple IDs share an email alias.
    let users = await neonSQL(
      `UPDATE users SET last_login = NOW() WHERE apple_id = $1
       RETURNING id, email, name, picture, COALESCE(session_version, 1) AS session_version`,
      [appleId]
    );

    if (users.length === 0) {
      // Not found by apple_id — upsert by email (new Apple user or Google user adding Apple)
      users = await neonSQL(
        `INSERT INTO users (apple_id, email, name, picture, last_login)
         VALUES ($1, $2, $3, '', NOW())
         ON CONFLICT (email) DO UPDATE SET
           apple_id = COALESCE(users.apple_id, $1),
           last_login = NOW(),
           name = CASE WHEN users.name IS NULL OR users.name = '' THEN $3 ELSE users.name END
         RETURNING id, email, name, picture, COALESCE(session_version, 1) AS session_version`,
        [appleId, email, name]
      );
    }

    const user = users[0];
    const sv = String(user.session_version || 1);

    // Generate HMAC-signed auth token (4hr expiry)
    // Bound to userId + email + session_version to prevent identity confusion and enable revocation
    const authTs = Math.floor(Date.now() / 1000);
    const secret = process.env.AUTH_TOKEN_SECRET;
    if (!secret) throw new Error('AUTH_TOKEN_SECRET not configured');
    const enc = new TextEncoder();
    const authKey = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const authSig = await crypto.subtle.sign(
      'HMAC', authKey,
      enc.encode(`auth:${user.id}:${email.toLowerCase().trim()}:${sv}:${authTs}`)
    );
    const authToken = Array.from(new Uint8Array(authSig))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Set HttpOnly auth cookie (format: userId|email|sv|ts|token)
    const cookieVal = encodeURIComponent(`${user.id}|${email.toLowerCase().trim()}|${sv}|${authTs}|${authToken}`);
    const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
    res.setHeader('Set-Cookie', `pc_auth=${cookieVal}; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=14400`);

    res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture || '' },
    });
  } catch (err) {
    console.error('Apple auth error:', err.message);
    res.status(401).json({ error: 'Apple authentication failed' });
  }
}

// ════════════════════════════════════════════════════════
// SIGNOUT (was api/signout.js)
// ════════════════════════════════════════════════════════
async function handleSignout(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit by IP
  const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
  if (!await checkRateLimit(ip, 'signout', 20)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Verify auth token before performing DB write to prevent forced logout of other users
  const auth = extractAuth(req);
  if (auth.userId && auth.token && auth.email && auth.ts) {
    const valid = await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv);
    if (valid) {
      try {
        await neonSQL(
          'UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE id = $1',
          [auth.userId]
        );
      } catch (e) { /* best-effort — cookie is cleared regardless */ }
    }
  }

  const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
  res.setHeader('Set-Cookie', [
    `pc_auth=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
    `pc_pro=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`,
  ]);

  return res.status(200).json({ success: true });
}

// ════════════════════════════════════════════════════════
// DELETE ACCOUNT (was api/delete-account.js)
// ════════════════════════════════════════════════════════
async function handleDeleteAccount(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const allowedOrigin = getAllowedOrigin(req);
  setSecurityHeaders(res);

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pro-Token, X-Pro-Email, X-Pro-Ts, X-Auth-Token, X-Auth-Email, X-Auth-Ts');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    if (!allowedOrigin && origin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(200).end();
  }

  if (origin && !allowedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkBodySize(req)) return res.status(413).json({ error: 'Request body too large' });

  try {
    // ── Rate limit by IP + email ──
    const ip = req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
    if (!await checkRateLimit(ip, 'delete-account', 10)) {
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }

    // ── Verify auth token (cookie-first, header fallback) ──
    const auth = extractAuth(req);
    const bodyEmail = (req.body.email || '').toLowerCase().trim();

    // Rate limit: 5 attempts per hour per email
    if (bodyEmail && !await checkRateLimit('email:' + bodyEmail, 'delete-account', 5)) {
      return res.status(429).json({ error: 'Too many attempts — try again later' });
    }

    if (!bodyEmail) return res.status(400).json({ error: 'Email required' });

    // Auth token must match the email being deleted
    if (auth.email.toLowerCase().trim() !== bodyEmail) {
      return res.status(403).json({ error: 'Email mismatch' });
    }

    if (!await verifyAuthToken(auth.email, auth.token, auth.ts, auth.userId, auth.sv)) {
      return res.status(401).json({ error: 'Invalid or expired auth token' });
    }

    // ── Invalidate all sessions before deleting ──
    // Increment session_version so any outstanding tokens become invalid immediately
    await neonSQL(`UPDATE users SET session_version = COALESCE(session_version, 1) + 1 WHERE LOWER(email) = $1`, [bodyEmail]);

    // ── Delete user data ──
    // portfolios are ON DELETE CASCADE from users table
    // Delete pro license first (no FK)
    await neonSQL(`DELETE FROM pro_licenses WHERE LOWER(email) = $1`, [bodyEmail]);

    // Delete api_usage records for this user
    await neonSQL(`DELETE FROM api_usage WHERE client_key = $1`, ['email:' + bodyEmail]);

    // Delete user (cascades to portfolios)
    const deleted = await neonSQL(
      `DELETE FROM users WHERE LOWER(email) = $1 RETURNING id`,
      [bodyEmail]
    );

    if (deleted.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Clear auth cookie so it can't be reused
    const secure = process.env.NODE_ENV === 'development' ? '' : '; Secure';
    res.setHeader('Set-Cookie', `pc_auth=; HttpOnly${secure}; SameSite=Strict; Path=/api; Max-Age=0`);

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete account error:', err.message);
    res.status(500).json({ error: 'Failed to delete account' });
  }
}
