const express = require('express');
const neonAuth = require('./neonAuth');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, checkBanned) => {
  const router = express.Router();

  function publicUser(u) {
    return {
      id:           u.id,
      email:        u.email,
      username:     u.username,
      display_name: u.display_name || u.username || '',
      avatar_url:   u.avatar_url || null,
      created_at:   u.created_at,
      updated_at:   u.updated_at
    };
  }

  router.get('/profile', verifyToken, checkBanned, async (req, res) => {
    try {
      const u = await db('users').where({ id: req.userId }).first();
      if (!u) return res.status(404).json({ error: 'User not found' });
      res.json({ user: publicUser(u) });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.put('/profile', verifyToken, checkBanned, async (req, res) => {
    try {
      const { display_name, email, avatar_url } = req.body;
      if (!display_name || !email) {
        return res.status(400).json({ error: 'Display name and email are required' });
      }

      const current = await db('users').where({ id: req.userId }).first();
      if (!current) return res.status(404).json({ error: 'User not found' });

      const updates = {
        display_name: String(display_name).trim().slice(0, 100),
        avatar_url:   avatar_url ? String(avatar_url).trim() : null,
        updated_at:   db.fn.now()
      };
      // Email is managed by Neon Auth; we mirror it locally for display but do not
      // change the sign-in email here (that requires a verified email-change flow).
      if (String(email).trim() && String(email).trim() === current.email) {
        // no-op; email unchanged
      }

      await db('users').where({ id: req.userId }).update(updates);
      const u = await db('users').where({ id: req.userId }).first();
      res.json({ message: 'Profile updated successfully', user: publicUser(u) });
    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.put('/password', verifyToken, checkBanned, async (req, res) => {
    try {
      const { current_password, new_password } = req.body;
      if (!current_password || !new_password) {
        return res.status(400).json({ error: 'Current and new password are required' });
      }
      if (new_password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      const u = await db('users').where({ id: req.userId }).first();
      if (!u?.email) return res.status(404).json({ error: 'User not found' });

      try {
        await neonAuth.changePassword({
          email: u.email,
          currentPassword: current_password,
          newPassword: new_password
        });
      } catch (err) {
        if (err.status === 401 || /incorrect|invalid/i.test(err.message || '')) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }
        return clientError(res, 400, 'Failed to update password', err);
      }

      // Invalidate existing app JWTs for this user.
      try {
        await db('users').where({ id: req.userId })
          .update({ token_version: db.raw('COALESCE(token_version, 0) + 1') });
      } catch (err) {
        console.warn('token_version bump skipped:', err.message);
      }

      res.json({ message: 'Password updated successfully. Please log in again.', reauth: true });
    } catch (error) {
      return clientError(res, 500, 'Server error', error);
    }
  });

  return router;
};
