const express = require('express');
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
  getTokenFromRequest
} = require('./sessionCookies');

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

  /** Public values the browser needs to start Neon Auth social sign-in. */
  router.get('/public-config', (req, res) => {
    res.json({
      authBaseUrl: neonAuth.base(),
      providers: ['google']
    });
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
