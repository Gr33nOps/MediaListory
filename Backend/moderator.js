const express = require('express');
const { syncUserFlags } = require('./userRoles');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, verifyModerator, logModeratorActivity) => {
  const router = express.Router();
  const supabase = null; // Identity is Neon Auth; roles/bans live in public.users.

  router.get('/stats', verifyToken, verifyModerator, async (req, res) => {
    try {
      const [totalUsers, totalModerators, bannedUsers] = await Promise.all([
        db('users').count('id as count').first(),
        db('users').where('is_moderator', true).count('id as count').first(),
        db('users').where('is_banned', true).count('id as count').first()
      ]);

      res.json({
        totalUsers:      parseInt(totalUsers?.count      || 0),
        totalModerators: parseInt(totalModerators?.count || 0),
        bannedUsers:     parseInt(bannedUsers?.count     || 0)
      });
    } catch (error) {
      console.error('Get stats error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.get('/users', verifyToken, verifyModerator, async (req, res) => {
    try {
      const { search, limit = 100, offset = 0 } = req.query;

      let query = db('users').select(
        'id', 'username', 'email', 'display_name', 'avatar_url',
        'created_at', 'is_moderator', 'is_admin', 'is_banned', 'banned_at', 'ban_reason'
      );

      if (search) {
        query = query.where(function () {
          this.where('username',     'ilike', `%${search}%`)
              .orWhere('email',        'ilike', `%${search}%`)
              .orWhere('display_name', 'ilike', `%${search}%`);
        });
      }

      const users = await query
        .orderBy('created_at', 'desc')
        .limit(parseInt(limit))
        .offset(parseInt(offset));

      const countResult = await db('users').count('id as total').first();

      res.json({ users, total: parseInt(countResult?.total || 0) });
    } catch (error) {
      console.error('Get users error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.put('/users/:id/ban', verifyToken, verifyModerator, async (req, res) => {
    try {
      const userId = req.params.id;
      const { reason } = req.body;

      if (userId === req.userId) {
        return res.status(400).json({ error: 'Cannot ban yourself' });
      }

      const user = await db('users').where({ id: userId }).first();
      if (!user)          return res.status(404).json({ error: 'User not found' });
      if (user.is_banned) return res.status(400).json({ error: 'User is already banned' });
      if (user.is_moderator || user.is_admin) {
        return res.status(403).json({ error: 'Cannot ban moderators or admins' });
      }

      await syncUserFlags(db, supabase, userId, {
        is_banned:  true,
        banned_at:  new Date().toISOString(),
        banned_by:  req.userId,
        ban_reason: reason || null
      });

      try {
        await db('ban_history').insert({
          user_id:    userId,
          banned_by:  req.userId,
          ban_reason: reason || null
        });
      } catch (_) {}

      await logModeratorActivity(req.userId, 'ban_user', 'user', userId, reason || 'No reason provided');

      res.json({ message: 'User banned successfully' });
    } catch (error) {
      console.error('Ban user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.put('/users/:id/unban', verifyToken, verifyModerator, async (req, res) => {
    try {
      const userId = req.params.id;

      const user = await db('users').where({ id: userId }).first();
      if (!user)           return res.status(404).json({ error: 'User not found' });
      if (!user.is_banned) return res.status(400).json({ error: 'User is not banned' });

      await syncUserFlags(db, supabase, userId, {
        is_banned:  false,
        banned_at:  null,
        banned_by:  null,
        ban_reason: null
      });

      try {
        await db('ban_history')
          .where({ user_id: userId })
          .whereNull('unbanned_at')
          .update({ unbanned_at: db.fn.now(), unbanned_by: req.userId });
      } catch (_) {}

      await logModeratorActivity(req.userId, 'unban_user', 'user', userId, `Unbanned ${user.username}`);

      res.json({ message: 'User unbanned successfully' });
    } catch (error) {
      console.error('Unban user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/activity', verifyToken, verifyModerator, async (req, res) => {
    try {
      const { limit = 50, offset = 0, action_type } = req.query;

      let query = db('moderator_activity')
        .leftJoin('users as moderator', 'moderator_activity.moderator_id', 'moderator.id')
        .leftJoin('users as target_user', function () {
          this.on(db.raw("moderator_activity.target_id::uuid = target_user.id"))
              .andOn(db.raw("moderator_activity.target_type = 'user'"));
        })
        .leftJoin('games as target_game', function () {
          this.on(db.raw("moderator_activity.target_id::bigint = target_game.id"))
              .andOn(db.raw("moderator_activity.target_type = 'game'"));
        })
        .select(
          'moderator_activity.*',
          'moderator.username as moderator_username',
          db.raw("CASE WHEN moderator_activity.target_type = 'user' THEN target_user.username END as target_username"),
          db.raw("CASE WHEN moderator_activity.target_type = 'game' THEN target_game.name END as target_name")
        );

      if (action_type) {
        query = query.where('moderator_activity.action_type', action_type);
      }

      const activities = await query
        .orderBy('moderator_activity.created_at', 'desc')
        .limit(parseInt(limit))
        .offset(parseInt(offset));

      res.json({ activities });
    } catch (error) {
      console.error('Get activity error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  return router;
};