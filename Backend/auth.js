const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const neonAuth = require('./neonAuth');
const { clientError } = require('./errors');
const {
  ensureLocalUser,
  findUserByUsername,
  isUsernameTaken,
  allocateUsername
} = require('./localUser');
const {
  attachAuthCookie,
  clearAuthCookieHeader,
  getTokenFromRequest,
  parseCookies
} = require('./sessionCookies');

// Direct OAuth2 (authorization-code) providers. Same-origin: the callback lives on
// our own domain, so the session cookie is first-party (no cross-domain cookie issues).
const OAUTH_PROVIDERS = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    extraAuthParams: { access_type: 'online', prompt: 'select_account' },
    async fetchIdentity(accessToken) {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const u = await r.json().catch(() => ({}));
      if (!r.ok || !u.email || u.email_verified === false) return null;
      return { sub: String(u.sub), email: u.email, name: u.name || null, image: u.picture || null };
    }
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
    extraAuthParams: {},
    async fetchIdentity(accessToken) {
      const headers = { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'MediaListory', Accept: 'application/vnd.github+json' };
      const ur = await fetch('https://api.github.com/user', { headers });
      const u = await ur.json().catch(() => ({}));
      if (!ur.ok || !u.id) return null;
      let email = u.email;
      if (!email) {
        const er = await fetch('https://api.github.com/user/emails', { headers });
        const emails = await er.json().catch(() => []);
        const primary = Array.isArray(emails)
          ? (emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified))
          : null;
        email = primary && primary.email;
      }
      if (!email) return null;
      return { sub: String(u.id), email, name: u.name || u.login || null, image: u.avatar_url || null };
    }
  }
};

module.exports = (db, jwt, JWT_SECRET, verifyToken, checkBanned) => {
  const router = express.Router();

  function sendAuthSession(res, token, user, extra = {}) {
    attachAuthCookie(res, token, !!extra.rememberMe);
    res.json({ token, user, ...extra });
  }

  // Build the client user shape from the local users row (+ optional identity).
  function formatUser(dbUser, identity = null) {
    const id = (dbUser && dbUser.id) || (identity && identity.id) || null;
    const email = (dbUser && dbUser.email) || (identity && identity.email) || '';
    return {
      id,
      email,
      username:     (dbUser && dbUser.username) || (email ? email.split('@')[0] : ''),
      display_name: (dbUser && dbUser.display_name) || (identity && identity.name) || (dbUser && dbUser.username) || '',
      avatar_url:   (dbUser && dbUser.avatar_url) || (identity && identity.image) || null,
      is_admin:     (dbUser && dbUser.is_admin) || false,
      is_moderator: (dbUser && dbUser.is_moderator) || false,
      is_banned:    (dbUser && dbUser.is_banned) || false,
      ban_reason:   (dbUser && dbUser.ban_reason) || null,
    };
  }

  function isUniqueViolation(err) {
    return err && (err.code === '23505' || /unique|duplicate/i.test(err.message || ''));
  }

  async function issueJwt(userId, rememberMe = false) {
    let tv = 0;
    try {
      const row = await db('users').where({ id: userId }).first('token_version');
      tv = Number(row?.token_version || 0);
    } catch (_) {}
    const expiresIn = rememberMe ? '30d' : '7d';
    return jwt.sign({ userId, tv }, JWT_SECRET, { expiresIn });
  }

  function enabledProviders() {
    return Object.keys(OAUTH_PROVIDERS).filter((p) => OAUTH_PROVIDERS[p].clientId() && OAUTH_PROVIDERS[p].clientSecret());
  }

  function publicOrigin(req) {
    let url = String(process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (!url) url = `${req.protocol}://${req.get('host')}`;
    return url;
  }
  function oauthCallbackUrl(req, provider) {
    return `${publicOrigin(req)}/api/auth/oauth/${provider}/callback`;
  }

  /** Which social providers the browser should offer (those actually configured). */
  router.get('/public-config', (req, res) => {
    res.json({ providers: enabledProviders() });
  });

  // ---- Direct OAuth2 (same-origin) --------------------------------------------
  // Step 1: redirect the browser to the provider with a CSRF state bound to a cookie.
  router.get('/oauth/:provider/start', (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    const P = OAUTH_PROVIDERS[provider];
    if (!P || !P.clientId() || !P.clientSecret()) {
      return res.status(404).send('This sign-in method is not available.');
    }
    const state = crypto.randomBytes(20).toString('hex');
    const remember = req.query.remember === '0' ? '0' : '1';
    const payload = encodeURIComponent(JSON.stringify({ state, provider, remember }));
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    // nosemgrep: javascript.express.session-fixation.session-fixation -- value is a server-generated CSRF state (crypto.randomBytes), never user input
    res.setHeader('Set-Cookie', `mgl_oauth=${payload}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);

    const params = new URLSearchParams({
      client_id: P.clientId(),
      redirect_uri: oauthCallbackUrl(req, provider),
      response_type: 'code',
      scope: P.scope,
      state
    });
    Object.entries(P.extraAuthParams || {}).forEach(([k, v]) => params.set(k, v));
    // nosemgrep: javascript.express.web.tainted-redirect-express.tainted-redirect-express -- P.authorizeUrl is a hardcoded provider endpoint; provider is validated against the OAUTH_PROVIDERS allowlist
    res.redirect(`${P.authorizeUrl}?${params.toString()}`);
  });

  // Step 2: provider redirects back here (same-origin). Exchange the code, map the
  // user, mint the app JWT, set the httpOnly cookie, and bounce to the app.
  router.get('/oauth/:provider/callback', async (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    const P = OAUTH_PROVIDERS[provider];
    const frontend = publicOrigin(req);
    const fail = (msg) => res.redirect(`${frontend}/auth.html?oauth_error=${encodeURIComponent(msg || 'Sign-in failed')}`);
    try {
      if (!P) return fail('Unknown sign-in provider');
      const { code, state, error } = req.query;
      if (error) return fail('Sign-in was cancelled');

      let stored = {};
      try { stored = JSON.parse(parseCookies(req).mgl_oauth || '{}'); } catch (_) {}
      const clearState = `mgl_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

      if (!code || !state || state !== stored.state || stored.provider !== provider) {
        res.setHeader('Set-Cookie', clearState);
        return fail('Your sign-in session expired. Please try again.');
      }

      const tokenRes = await fetch(P.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: P.clientId(),
          client_secret: P.clientSecret(),
          code: String(code),
          redirect_uri: oauthCallbackUrl(req, provider),
          grant_type: 'authorization_code'
        }).toString()
      });
      const tokenData = await tokenRes.json().catch(() => ({}));
      const accessToken = tokenData.access_token;
      if (!accessToken) { res.setHeader('Set-Cookie', clearState); return fail('Could not complete sign-in'); }

      const identity = await P.fetchIdentity(accessToken);
      if (!identity || !identity.email) { res.setHeader('Set-Cookie', clearState); return fail('Could not read a verified email from your account'); }

      const authId = `${provider}:${identity.sub}`;
      let dbUser = await db('users').where({ auth_id: authId }).first();
      if (!dbUser) dbUser = await db('users').whereRaw('LOWER(email) = LOWER(?)', [identity.email]).first();
      if (!dbUser) {
        const username = await allocateUsername(db, identity.name || identity.email.split('@')[0]);
        try {
          const [row] = await db('users').insert({
            auth_id: authId,
            username,
            email: identity.email,
            display_name: String(identity.name || username).slice(0, 100),
            avatar_url: identity.image || null
          }).returning('id');
          dbUser = await db('users').where({ id: row.id ?? row }).first();
        } catch (_) {
          dbUser = await db('users').whereRaw('LOWER(email) = LOWER(?)', [identity.email]).first();
        }
      } else if (!dbUser.auth_id) {
        await db('users').where({ id: dbUser.id }).update({ auth_id: authId });
      }
      if (!dbUser) { res.setHeader('Set-Cookie', clearState); return fail('Could not create your profile'); }
      if (dbUser.is_banned) { res.setHeader('Set-Cookie', clearState); return fail('Your account has been banned'); }

      const rememberMe = stored.remember !== '0';
      const appToken = await issueJwt(dbUser.id, rememberMe);
      const maxAgeSec = rememberMe ? 30 * 24 * 60 * 60 : 7 * 24 * 60 * 60;
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      // nosemgrep: javascript.express.session-fixation.session-fixation -- appToken is a server-signed JWT (jwt.sign), not user-controlled
      res.setHeader('Set-Cookie', [
        clearState,
        `mgl_token=${encodeURIComponent(appToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`
      ]);
      return res.redirect(`${frontend}/auth.html?oauth=done`);
    } catch (error) {
      console.error('OAuth callback error:', error.message);
      return fail('Sign-in failed. Please try again.');
    }
  });

  /**
   * Finish social (Google) OAuth. The browser exchanges its Neon Auth session for a
   * JWT (GET {authBaseUrl}/token) and posts it here. Body: { token, rememberMe? }.
   */
  router.post('/oauth/complete', async (req, res) => {
    try {
      const token = String(req.body?.token || req.body?.access_token || '').trim();
      const rememberMe = !!req.body?.rememberMe;
      if (!token) return res.status(400).json({ error: 'token is required' });

      let identity;
      try {
        identity = await neonAuth.verifyJwt(token);
      } catch (_) {
        return res.status(401).json({ error: 'Invalid or expired sign-in token' });
      }

      const existing = await db('users').where({ id: identity.id }).first();
      const isNewUser = !existing;

      const preferred = identity.name || (identity.email || '').split('@')[0] || 'player';
      const username = isNewUser
        ? await allocateUsername(db, preferred, identity.id)
        : (existing.username || await allocateUsername(db, preferred, identity.id));

      let dbUser;
      try {
        dbUser = await ensureLocalUser(db, identity, {
          username,
          display_name: (identity.name || preferred).toString().slice(0, 100),
          avatar_url: identity.image || null
        });
      } catch (err) {
        console.warn('ensureLocalUser on oauth:', err.message);
        dbUser = await db('users').where({ id: identity.id }).first();
      }
      if (!dbUser) return res.status(500).json({ error: 'Could not create local user profile' });
      if (dbUser.is_banned) {
        return res.status(403).json({ error: 'Your account has been banned.', reason: dbUser.ban_reason || null });
      }

      const appToken = await issueJwt(dbUser.id, rememberMe);
      sendAuthSession(res, appToken, formatUser(dbUser, identity), {
        rememberMe,
        needsUsername: false,
        suggestedUsername: dbUser.username
      });
    } catch (error) {
      return clientError(res, 500, 'OAuth login failed', error);
    }
  });

  /** Claim / change username. */
  router.put('/username', verifyToken, checkBanned, async (req, res) => {
    try {
      const clean = String(req.body?.username || '').trim();
      if (!/^[a-zA-Z0-9_]{3,50}$/.test(clean)) {
        return res.status(400).json({ error: 'Username must be 3-50 characters (letters, numbers, underscores).' });
      }
      if (await isUsernameTaken(db, clean, req.userId)) {
        return res.status(400).json({ error: 'Username already taken' });
      }
      await db('users').where({ id: req.userId }).update({ username: clean, updated_at: db.fn.now() });
      const dbUser = await db('users').where({ id: req.userId }).first();
      res.json({ message: 'Username saved', user: formatUser(dbUser) });
    } catch (error) {
      return clientError(res, 500, 'Could not save username', error);
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const { username, email, display_name, password } = req.body;
      if (!username || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const cleanUsername = String(username).trim();
      if (cleanUsername.length < 3 || cleanUsername.length > 50) {
        return res.status(400).json({ error: 'Username must be 3-50 characters' });
      }
      if (await isUsernameTaken(db, cleanUsername)) {
        return res.status(400).json({ error: 'Username already taken' });
      }

      let identity;
      try {
        const result = await neonAuth.signUpEmail({
          name: display_name || cleanUsername,
          email,
          password
        });
        identity = result.user;
      } catch (err) {
        if (err.code === 'USER_ALREADY_EXISTS' || /already/i.test(err.message || '')) {
          return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });
        }
        return clientError(res, err.status || 400, 'Registration failed', err);
      }

      let dbUser;
      try {
        dbUser = await ensureLocalUser(db, identity, {
          username: cleanUsername,
          display_name: display_name || cleanUsername
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return res.status(400).json({ error: 'Username already taken' });
        }
        console.warn('ensureLocalUser on register:', err.message);
        dbUser = await db('users').where({ id: identity.id }).first();
      }
      if (!dbUser) return res.status(500).json({ error: 'Could not create user profile' });

      // Neon Auth is configured with verification not required, so sign the user in immediately.
      const appToken = await issueJwt(dbUser.id, false);
      sendAuthSession(res, appToken, formatUser(dbUser, identity), {
        success: true,
        message: 'Account created!'
      });
    } catch (error) {
      console.error('Registration error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  // Email verification is not required with the current Neon Auth configuration.
  router.post('/verify-email', (req, res) => {
    res.json({ success: true, message: 'Your email is ready to use. You can log in.' });
  });
  router.post('/resend-verification', (req, res) => {
    res.json({ success: true, message: 'No verification needed - you can log in.' });
  });

  router.get('/check-username/:username', async (req, res) => {
    try {
      const exists = await isUsernameTaken(db, req.params.username);
      res.json({ exists });
    } catch (error) {
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { emailOrUsername, password, rememberMe } = req.body;
      if (!emailOrUsername || !password) {
        return res.status(400).json({ error: 'Email/username and password are required' });
      }

      let email = emailOrUsername;
      if (!emailOrUsername.includes('@')) {
        const match = await findUserByUsername(db, emailOrUsername);
        if (!match?.email) return res.status(401).json({ error: 'Invalid credentials' });
        email = match.email;
      }

      let identity;
      try {
        const result = await neonAuth.signInEmail({ email, password });
        identity = result.user;
      } catch (err) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      let dbUser;
      try {
        dbUser = await ensureLocalUser(db, identity);
      } catch (err) {
        console.warn('ensureLocalUser on login:', err.message);
        dbUser = await db('users').where({ id: identity.id }).first();
      }
      if (dbUser?.is_banned) {
        return res.status(403).json({ error: 'Your account has been banned.', reason: dbUser.ban_reason || null });
      }

      const appToken = await issueJwt(dbUser?.id || identity.id, rememberMe);
      sendAuthSession(res, appToken, formatUser(dbUser, identity), { rememberMe });
    } catch (error) {
      return clientError(res, 500, 'Login failed', error);
    }
  });

  /** Restore / slide a session from the app's own JWT (Bearer or cookie). */
  router.get('/session', async (req, res) => {
    try {
      const existing = getTokenFromRequest(req);
      if (!existing) return res.status(401).json({ error: 'Unauthorized' });

      let payload;
      try {
        payload = jwt.verify(existing, JWT_SECRET);
      } catch (_) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const userId = payload.userId || payload.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const dbUser = await db('users').where({ id: userId }).first();
      if (!dbUser) return res.status(401).json({ error: 'Unauthorized' });
      if (dbUser.is_banned) {
        return res.status(403).json({ error: 'Your account has been banned.', reason: dbUser.ban_reason || null });
      }
      if (payload.tv != null && Number(payload.tv) !== Number(dbUser.token_version || 0)) {
        return res.status(401).json({ error: 'Session expired. Please sign in again.' });
      }

      const token = await issueJwt(userId, true);
      sendAuthSession(res, token, formatUser(dbUser), { rememberMe: true });
    } catch (error) {
      return clientError(res, 500, 'Session restore failed', error);
    }
  });

  router.get('/verify', verifyToken, async (req, res) => {
    try {
      const dbUser = await db('users').where({ id: req.userId }).first();
      if (!dbUser) return res.status(404).json({ error: 'User not found' });
      if (dbUser.is_banned) return res.status(403).json({ error: 'Your account has been banned.' });
      res.json({ valid: true, user: formatUser(dbUser) });
    } catch (error) {
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.get('/me', verifyToken, async (req, res) => {
    try {
      const dbUser = await db('users').where({ id: req.userId }).first();
      if (!dbUser) return res.status(404).json({ error: 'User not found' });
      res.json({ user: formatUser(dbUser) });
    } catch (error) {
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.post('/forgot-password', async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });

      let frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      if (frontendUrl && !/^https?:\/\//i.test(frontendUrl)) frontendUrl = `https://${frontendUrl}`;

      await neonAuth.requestPasswordReset({ email, redirectTo: `${frontendUrl}/auth.html?type=recovery` });
      res.json({ success: true, message: 'If a matching account exists, a reset link has been sent.' });
    } catch (error) {
      console.error('Forgot password error:', error);
      res.json({ success: true, message: 'If a matching account exists, a reset link has been sent.' });
    }
  });

  router.post('/reset-password', async (req, res) => {
    try {
      const { code, token, password } = req.body;
      const resetToken = token || code;
      if (!resetToken || !password) {
        return res.status(400).json({ error: 'Reset token and new password are required' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      try {
        await neonAuth.resetPassword({ token: resetToken, newPassword: password });
      } catch (_) {
        return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
      }
      res.json({ success: true, message: 'Password reset successfully!' });
    } catch (error) {
      return clientError(res, 500, 'Password reset failed', error);
    }
  });

  router.post('/logout', async (req, res) => {
    clearAuthCookieHeader(res);
    res.json({ success: true, message: 'Logged out successfully' });
  });

  return router;
};
