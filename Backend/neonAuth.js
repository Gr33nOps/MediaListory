/**
 * Server-side client for Neon Auth (Better Auth REST API).
 * Replaces Supabase Auth as the identity provider. The app still mints its own
 * short-lived JWT after verifying identity here, so the rest of the app (verifyToken,
 * sessions, public.users) is unchanged.
 *
 * Env:
 *   NEON_AUTH_BASE_URL  e.g. https://<ep>.neonauth.<region>.aws.neon.tech/neondb/auth
 *   NEON_AUTH_JWKS_URL  <base>/.well-known/jwks.json  (defaults from BASE)
 *   FRONTEND_URL        used as the Origin header (must be a Neon Auth trusted domain)
 */

const { createRemoteJWKSet, jwtVerify } = require('jose');

function base() {
  return String(process.env.NEON_AUTH_BASE_URL || '').replace(/\/$/, '');
}

function jwksUrl() {
  return process.env.NEON_AUTH_JWKS_URL || `${base()}/.well-known/jwks.json`;
}

// Better Auth enforces a CSRF check against trusted domains via the Origin header.
function origin() {
  let url = String(process.env.FRONTEND_URL || 'http://localhost:3000').trim().replace(/\/$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function isConfigured() {
  return !!base();
}

let _jwks;
function getJwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(new URL(jwksUrl()));
  return _jwks;
}

async function call(path, { method = 'POST', body, headers = {} } = {}) {
  if (!isConfigured()) {
    const err = new Error('Neon Auth is not configured (NEON_AUTH_BASE_URL)');
    err.status = 500;
    throw err;
  }
  const res = await fetch(base() + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin(), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  return { res, data };
}

function authError(res, data, fallback) {
  const err = new Error((data && data.message) || fallback);
  err.status = res.status;
  err.code = data && data.code;
  return err;
}

/** Create an email/password account. Returns the Neon Auth user + session token. */
async function signUpEmail({ name, email, password }) {
  const { res, data } = await call('/sign-up/email', { body: { name, email, password } });
  if (!res.ok) throw authError(res, data, 'Sign up failed');
  return { user: data.user, token: data.token };
}

/** Verify email/password. Returns the Neon Auth user + session token, or throws. */
async function signInEmail({ email, password }) {
  const { res, data } = await call('/sign-in/email', { body: { email, password } });
  if (!res.ok) throw authError(res, data, 'Invalid email or password');
  return { user: data.user, token: data.token };
}

/**
 * Change a user's password. Better Auth requires an authenticated session, so we
 * sign in with the current password to get a session cookie, then change it.
 */
async function changePassword({ email, currentPassword, newPassword }) {
  const signIn = await call('/sign-in/email', { body: { email, password: currentPassword } });
  if (!signIn.res.ok) throw authError(signIn.res, signIn.data, 'Current password is incorrect');
  const cookie = (signIn.res.headers.get('set-cookie') || '').split(';')[0];
  const { res, data } = await call('/change-password', {
    headers: cookie ? { Cookie: cookie } : {},
    body: { currentPassword, newPassword, revokeOtherSessions: true }
  });
  if (!res.ok) throw authError(res, data, 'Failed to change password');
  return true;
}

/** Best-effort password reset request (requires a configured Neon Auth email provider). */
async function requestPasswordReset({ email, redirectTo }) {
  await call('/request-password-reset', { body: { email, redirectTo } }).catch(() => {});
  await call('/forget-password', { body: { email, redirectTo } }).catch(() => {});
  return true;
}

/**
 * Verify a Neon Auth JWT (EdDSA, signed with the project JWKS) and return the
 * identity as a { id, email, name, image } object. Used for OAuth completion.
 */
async function verifyJwt(token) {
  const { payload } = await jwtVerify(token, getJwks());
  const id = payload.sub || payload.id || payload.userId;
  if (!id) {
    const err = new Error('Neon Auth token missing subject');
    err.status = 401;
    throw err;
  }
  return {
    id: String(id),
    email: payload.email || null,
    name: payload.name || null,
    image: payload.image || payload.picture || null
  };
}

module.exports = {
  isConfigured,
  base,
  origin,
  signUpEmail,
  signInEmail,
  changePassword,
  requestPasswordReset,
  verifyJwt
};
