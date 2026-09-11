const express = require('express');
const neonAuth = require('./neonAuth');
const taste = require('./taste');
const avatars = require('./avatars');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, checkBanned) => {
  const router = express.Router();

  // Selected in place of avatar_url so the data URI never leaves Postgres.
  const USER_FIELDS = ['id', 'email', 'username', 'display_name', 'bio', 'accent',
                       'banner_style', 'is_private', 'created_at', 'updated_at'];
  function userSelect() {
    return db('users').select(...USER_FIELDS, ...avatars.columns(db, 'users'));
  }

  function publicUser(u, req) {
    return {
      id:           u.id,
      email:        u.email,
      username:     u.username,
      display_name: u.display_name || u.username || '',
      avatar_url:   avatars.urlFor(req, u),
      bio:          u.bio || '',
      accent:       u.accent || null,
      banner_style: u.banner_style || 'posters',
      is_private:   !!u.is_private,
      created_at:   u.created_at,
      updated_at:   u.updated_at
    };
  }

  const MEDIA_TYPES = ['movie', 'series', 'anime', 'game'];
  const ACCENTS = ['movie', 'series', 'anime', 'game'];
  const BANNER_STYLES = ['posters', 'accent'];
  const TOP_LIMIT = 10;
  const CURRENT_LIMIT = 6;

  router.get('/profile', verifyToken, checkBanned, async (req, res) => {
    try {
      const u = await userSelect().where({ id: req.userId }).first();
      if (!u) return res.status(404).json({ error: 'User not found' });
      res.json({ user: publicUser(u, req) });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.put('/profile', verifyToken, checkBanned, async (req, res) => {
    try {
      const { display_name, email, avatar_url, is_private } = req.body;
      if (!display_name || !email) {
        return res.status(400).json({ error: 'Display name and email are required' });
      }

      const current = await db('users').where({ id: req.userId }).select('email').first();
      if (!current) return res.status(404).json({ error: 'User not found' });

      // Avatar is either a remote https URL (Google/GitHub sign-in, ui-avatars)
      // or an uploaded data: URI. GIF is allowed through so animated pictures
      // survive; the client keeps those whole rather than flattening them.
      let avatar = avatar_url ? String(avatar_url).trim() : null;
      if (avatar) {
        const isRemote = /^https:\/\//i.test(avatar);
        const isImageData = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(avatar);
        if (!isRemote && !isImageData) {
          return res.status(400).json({ error: 'Profile picture must be an https URL or an uploaded PNG, JPEG, GIF, or WebP.' });
        }
        // Say so rather than saving the rest of the profile with the picture
        // quietly dropped, which reads as a successful save that did not stick.
        if (avatar.length > 400000) {
          return res.status(413).json({ error: 'That profile picture is too large. Please use a smaller image.' });
        }
      }

      const { bio, accent, banner_style } = req.body;

      const updates = {
        display_name: String(display_name).trim().slice(0, 100),
        avatar_url:   avatar,
        updated_at:   db.fn.now()
      };
      if (typeof is_private !== 'undefined') {
        updates.is_private = (is_private === true || is_private === 'true' || is_private === 1);
      }
      // Each of these is only touched when sent, so a client that predates them
      // does not wipe what the user already chose.
      if (typeof bio !== 'undefined') {
        updates.bio = String(bio == null ? '' : bio).trim().slice(0, 300) || null;
      }
      if (typeof accent !== 'undefined') {
        updates.accent = ACCENTS.includes(accent) ? accent : null;
      }
      if (typeof banner_style !== 'undefined') {
        updates.banner_style = BANNER_STYLES.includes(banner_style) ? banner_style : 'posters';
      }
      // Email is managed by Neon Auth; we mirror it locally for display but do not
      // change the sign-in email here (that requires a verified email-change flow).
      if (String(email).trim() && String(email).trim() === current.email) {
        // no-op; email unchanged
      }

      await db('users').where({ id: req.userId }).update(updates);
      const u = await userSelect().where({ id: req.userId }).first();
      res.json({ message: 'Profile updated successfully', user: publicUser(u, req) });
    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  /* ── Top 10 of all time, one list per category ─────────────────────────── */

  // Shape rows for the profile: poster, name, and the ref the browse pages open.
  function topSelect(query) {
    return query
      .join('games as g', 'g.id', 'user_top_media.game_id')
      .select(
        'user_top_media.media_type', 'user_top_media.position',
        'g.id as game_row_id', 'g.game_id', 'g.name', 'g.background_image', 'g.released'
      )
      .orderBy('user_top_media.media_type')
      .orderBy('user_top_media.position');
  }

  function groupTop(rows) {
    const out = { movie: [], series: [], anime: [], game: [] };
    for (const r of rows) {
      if (!out[r.media_type]) continue;
      out[r.media_type].push({
        position: Number(r.position),
        game_id: r.game_id,
        name: r.name,
        background_image: r.background_image,
        released: r.released
      });
    }
    return out;
  }

  router.get('/profile/top', verifyToken, checkBanned, async (req, res) => {
    try {
      const rows = await topSelect(db('user_top_media').where('user_top_media.user_id', req.userId));
      res.json({ top: groupTop(rows) });
    } catch (error) {
      return clientError(res, 400, 'Request failed', error);
    }
  });

  // Replaces one category's list outright. The client sends the order it wants,
  // so reordering, adding, and removing are all the same call and there is never
  // a half-applied list.
  router.put('/profile/top/:mediaType', verifyToken, checkBanned, async (req, res) => {
    const mediaType = String(req.params.mediaType || '');
    if (!MEDIA_TYPES.includes(mediaType)) {
      return res.status(400).json({ error: 'Unknown category' });
    }
    const refs = Array.isArray(req.body?.game_ids) ? req.body.game_ids.map(String) : null;
    if (!refs) return res.status(400).json({ error: 'game_ids must be an array' });
    if (refs.length > TOP_LIMIT) {
      return res.status(400).json({ error: `A Top 10 holds at most ${TOP_LIMIT} titles.` });
    }

    try {
      // Resolve external refs to catalog rows, and refuse anything filed under a
      // different category so a game cannot be ranked in the movies Top 10.
      const unique = [...new Set(refs)];
      const games = unique.length
        ? await db('games').whereIn('game_id', unique).select('id', 'game_id', 'media_type')
        : [];
      const byRef = new Map(games.map(g => [String(g.game_id), g]));

      const rows = [];
      const seen = new Set();
      for (const ref of refs) {
        const g = byRef.get(ref);
        if (!g) return res.status(400).json({ error: `Not in the catalog yet: ${ref}` });
        if (g.media_type !== mediaType) {
          return res.status(400).json({ error: `"${ref}" is not a ${mediaType}.` });
        }
        if (seen.has(ref)) continue;
        seen.add(ref);
        rows.push({ user_id: req.userId, media_type: mediaType, game_id: g.id, position: rows.length + 1 });
      }

      await db.transaction(async (trx) => {
        await trx('user_top_media').where({ user_id: req.userId, media_type: mediaType }).del();
        if (rows.length) await trx('user_top_media').insert(rows);
      });

      taste.invalidate(req.userId);
      const fresh = await topSelect(db('user_top_media').where('user_top_media.user_id', req.userId));
      res.json({ message: 'Top 10 updated', top: groupTop(fresh) });
    } catch (error) {
      return clientError(res, 400, 'Could not save that Top 10', error);
    }
  });

  /* ── Currently into ────────────────────────────────────────────────────── */

  // The profile falls back to the most recently updated in-progress titles, so
  // this endpoint only records a deliberate override.
  router.put('/profile/current', verifyToken, checkBanned, async (req, res) => {
    const refs = Array.isArray(req.body?.game_ids) ? req.body.game_ids.map(String) : null;
    if (!refs) return res.status(400).json({ error: 'game_ids must be an array' });
    if (refs.length > CURRENT_LIMIT) {
      return res.status(400).json({ error: `You can pin at most ${CURRENT_LIMIT} titles.` });
    }

    try {
      const rows = refs.length
        ? await db('user_game_lists as ugl')
            .join('games as g', 'g.id', 'ugl.game_id')
            .where('ugl.user_id', req.userId)
            .whereIn('g.game_id', refs)
            .select('ugl.id')
        : [];

      await db.transaction(async (trx) => {
        await trx('user_game_lists').where({ user_id: req.userId }).update({ show_on_profile: false });
        if (rows.length) {
          await trx('user_game_lists').whereIn('id', rows.map(r => r.id)).update({ show_on_profile: true });
        }
      });

      res.json({ message: 'Updated', pinned: rows.length });
    } catch (error) {
      return clientError(res, 400, 'Could not save that selection', error);
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

  /* Wipe everything derived from the collection - library, custom lists (and
     the games inside them, via cascade), Top 10s, and season ratings - but
     keep the account and profile untouched. user_season_entries references
     users(id) directly rather than through user_game_lists, so it needs its
     own delete; custom_list_games cascades off custom_lists. */
  router.delete('/data', verifyToken, checkBanned, async (req, res) => {
    try {
      await db.transaction(async (trx) => {
        await trx('user_season_entries').where({ user_id: req.userId }).del();
        await trx('user_game_lists').where({ user_id: req.userId }).del();
        await trx('custom_lists').where({ user_id: req.userId }).del();
        await trx('user_top_media').where({ user_id: req.userId }).del();
      });
      res.json({ message: 'Your collection has been cleared.' });
    } catch (error) {
      return clientError(res, 500, 'Could not clear your data', error);
    }
  });

  /* Permanently delete the account. Every table that references it (library,
     lists, follows, follow requests, top media, season ratings) is declared
     ON DELETE CASCADE, so one delete on users unwinds all of it. Typing the
     exact username is the confirmation - it works the same way whether the
     account signs in with a password or with Google/GitHub. */
  router.delete('/account', verifyToken, checkBanned, async (req, res) => {
    try {
      const u = await db('users').where({ id: req.userId }).first('username');
      if (!u) return res.status(404).json({ error: 'User not found' });

      const typed = String(req.body?.username || '').trim().toLowerCase();
      if (!typed || typed !== String(u.username).toLowerCase()) {
        return res.status(400).json({ error: 'Type your username exactly to confirm.' });
      }

      await db('users').where({ id: req.userId }).del();
      res.json({ message: 'Account deleted.' });
    } catch (error) {
      return clientError(res, 500, 'Could not delete your account', error);
    }
  });

  return router;
};
