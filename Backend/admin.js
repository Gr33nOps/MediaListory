const express = require('express');
const { syncUserFlags } = require('./userRoles');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, verifyModerator, verifyAdmin, logModeratorActivity) => {
  const router = express.Router();

  // Identity is Neon Auth; role/ban state lives in public.users (source of truth).
  const supabase = null;

  router.get('/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const { search, limit = 100, offset = 0 } = req.query;

      let query = db('users').select(
        'id', 'username', 'email', 'display_name', 'avatar_url',
        'created_at', 'is_moderator', 'is_admin', 'is_banned', 'banned_at', 'ban_reason'
      );

      if (search) {
        query = query.where(function () {
          this.where('username', 'ilike', `%${search}%`)
            .orWhere('email', 'ilike', `%${search}%`)
            .orWhere('display_name', 'ilike', `%${search}%`);
        });
      }

      const users = await query
        .orderBy('created_at', 'desc')
        .limit(parseInt(limit, 10))
        .offset(parseInt(offset, 10));

      const countQuery = db('users');
      if (search) {
        countQuery.where(function () {
          this.where('username', 'ilike', `%${search}%`)
            .orWhere('email', 'ilike', `%${search}%`)
            .orWhere('display_name', 'ilike', `%${search}%`);
        });
      }
      const countResult = await countQuery.count('id as total').first();

      res.json({
        users,
        total: parseInt(countResult?.total || 0, 10)
      });
    } catch (error) {
      console.error('Get users error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.put('/users/:id/ban', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const userId = req.params.id;
      const { reason } = req.body;

      if (userId === req.userId) {
        return res.status(400).json({ error: 'Cannot ban yourself' });
      }

      const dbUser = await db('users').where({ id: userId }).first();
      if (!dbUser) return res.status(404).json({ error: 'User not found' });

      const isBanned = dbUser.is_banned || false;
      const isAdmin = dbUser.is_admin || false;

      if (isBanned) return res.status(400).json({ error: 'User is already banned' });
      if (isAdmin)  return res.status(403).json({ error: 'Cannot ban an admin' });

      const bannedAt = new Date().toISOString();
      await syncUserFlags(db, supabase, userId, {
        is_banned:  true,
        banned_at:  bannedAt,
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

  router.put('/users/:id/unban', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const userId = req.params.id;

      const dbUser = await db('users').where({ id: userId }).first();
      if (!dbUser) return res.status(404).json({ error: 'User not found' });

      const isBanned = dbUser.is_banned || false;
      if (!isBanned) return res.status(400).json({ error: 'User is not banned' });

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

      await logModeratorActivity(
        req.userId, 'unban_user', 'user', userId,
        `Unbanned ${dbUser.username || userId}`
      );

      res.json({ message: 'User unbanned successfully' });
    } catch (error) {
      console.error('Unban user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.put('/users/:id/promote', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const userId = req.params.id;

      const dbUser = await db('users').where({ id: userId }).first();
      if (!dbUser) return res.status(404).json({ error: 'User not found' });

      const isModerator = dbUser.is_moderator || false;
      if (isModerator) return res.status(400).json({ error: 'User is already a moderator' });

      await syncUserFlags(db, supabase, userId, { is_moderator: true });

      await logModeratorActivity(
        req.userId, 'promote_moderator', 'user', userId,
        `Promoted ${dbUser.username || userId} to moderator`
      );

      res.json({ message: 'User promoted to moderator successfully' });
    } catch (error) {
      console.error('Promote moderator error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.put('/users/:id/demote', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const userId = req.params.id;

      if (userId === req.userId) {
        return res.status(400).json({ error: 'Cannot demote yourself' });
      }

      const dbUser = await db('users').where({ id: userId }).first();
      if (!dbUser) return res.status(404).json({ error: 'User not found' });

      const isAdmin = dbUser.is_admin || false;
      const isModerator = dbUser.is_moderator || false;
      if (isAdmin)      return res.status(403).json({ error: 'Cannot demote an admin' });
      if (!isModerator) return res.status(400).json({ error: 'User is not a moderator' });

      await syncUserFlags(db, supabase, userId, { is_moderator: false });

      await logModeratorActivity(
        req.userId, 'demote_moderator', 'user', userId,
        `Demoted ${dbUser.username || userId} from moderator`
      );

      res.json({ message: 'Moderator demoted successfully' });
    } catch (error) {
      console.error('Demote moderator error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const userId = req.params.id;

      if (userId === req.userId) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      const dbUser = await db('users').where({ id: userId }).first();
      if (!dbUser) return res.status(404).json({ error: 'User not found' });
      if (dbUser.is_admin) return res.status(403).json({ error: 'Cannot delete an admin' });

      // Deleting the users row cascades to lists, follows, ban_history, and
      // moderator_activity (all ON DELETE CASCADE). The identity still exists in
      // Neon Auth; remove it from the Neon console/CLI to fully revoke sign-in.
      await db('users').where({ id: userId }).delete();

      await logModeratorActivity(
        req.userId, 'delete_user', 'user', userId,
        `Permanently deleted ${dbUser.username || userId}`
      );

      res.json({ message: 'User permanently deleted successfully' });
    } catch (error) {
      console.error('Delete user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/stats', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const [totalUsers, totalModerators, bannedUsers] = await Promise.all([
        db('users').count('id as count').first(),
        db('users').where({ is_moderator: true, is_admin: false }).count('id as count').first(),
        db('users').where({ is_banned: true }).count('id as count').first()
      ]);

      res.json({
        totalUsers:      parseInt(totalUsers?.count || 0, 10),
        totalModerators: parseInt(totalModerators?.count || 0, 10),
        bannedUsers:     parseInt(bannedUsers?.count || 0, 10)
      });
    } catch (error) {
      console.error('Get stats error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.get('/activity', verifyToken, verifyAdmin, async (req, res) => {
    try {
      const { limit = 50, offset = 0, action_type } = req.query;

      let query = db('moderator_activity')
        .select('moderator_activity.*')
        .orderBy('moderator_activity.created_at', 'desc')
        .limit(parseInt(limit))
        .offset(parseInt(offset));

      if (action_type) query = query.where('moderator_activity.action_type', action_type);

      const activities = await query;

      const uuidSet = new Set();
      activities.forEach(activity => {
        if (activity.moderator_id) uuidSet.add(activity.moderator_id);
        if (activity.target_type === 'user' && activity.target_id) uuidSet.add(String(activity.target_id));
      });

      const ids = [...uuidSet];
      const dbUsers = ids.length
        ? await db('users').whereIn('id', ids).select('id', 'username', 'email')
        : [];
      const userMap = Object.fromEntries(
        dbUsers.map(u => [u.id, u.username || u.email || u.id])
      );

      const enriched = activities.map(activity => ({
        ...activity,
        moderator_username: userMap[activity.moderator_id] || null,
        target_username:    activity.target_type === 'user' ? (userMap[String(activity.target_id)] || null) : null,
        target_name:        null
      }));

      const gameTargetIds = enriched
        .filter(activity => activity.target_type === 'game' && activity.target_id)
        .map(activity => activity.target_id);

      if (gameTargetIds.length > 0) {
        try {
          const games = await db('games').whereIn('id', gameTargetIds).select('id', 'name');
          const gameMap = Object.fromEntries(games.map(game => [game.id, game.name]));
          enriched.forEach(activity => {
            if (activity.target_type === 'game' && activity.target_id) {
              activity.target_name = gameMap[activity.target_id] || null;
            }
          });
        } catch (_) {}
      }

      res.json({ activities: enriched });
    } catch (error) {
      console.error('Get activity error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  return router;
};