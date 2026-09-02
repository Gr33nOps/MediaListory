const express = require('express');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, checkBanned) => {
  const router = express.Router();

  function mapDbUser(row, extra = {}) {
    return {
      id:           row.id,
      username:     row.username || 'unknown',
      display_name: row.display_name || row.username || '',
      avatar_url:   row.avatar_url || null,
      ...extra
    };
  }

  router.get('/users/search', verifyToken, checkBanned, async (req, res) => {
    try {
      const { query } = req.query;

      if (!query || query.trim().length < 2) {
        return res.json({ users: [] });
      }

      const searchTerm = `%${query.trim().toLowerCase()}%`;

      const rows = await db('users')
        .where('is_banned', false)
        .whereNot('id', req.userId)
        .andWhere(function () {
          this.whereRaw('LOWER(username) LIKE ?', [searchTerm])
            .orWhereRaw('LOWER(COALESCE(display_name, \'\')) LIKE ?', [searchTerm]);
        })
        .orderBy('username', 'asc')
        .limit(10)
        .select('id', 'username', 'display_name', 'avatar_url');

      res.json({ users: rows.map(row => mapDbUser(row)) });
    } catch (error) {
      console.error('Search users error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/following', verifyToken, checkBanned, async (req, res) => {
    try {
      const rows = await db('user_follows as f')
        .join('users as u', 'f.following_id', 'u.id')
        .where('f.follower_id', req.userId)
        .where('u.is_banned', false)
        .orderBy('f.created_at', 'desc')
        .select(
          'u.id',
          'u.username',
          'u.display_name',
          'u.avatar_url',
          'f.created_at as followed_since'
        );

      res.json({
        following: rows.map(row => mapDbUser(row, { followed_since: row.followed_since }))
      });
    } catch (error) {
      console.error('Get following error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/followers', verifyToken, checkBanned, async (req, res) => {
    try {
      const rows = await db('user_follows as f')
        .join('users as u', 'f.follower_id', 'u.id')
        .where('f.following_id', req.userId)
        .where('u.is_banned', false)
        .orderBy('f.created_at', 'desc')
        .select(
          'u.id',
          'u.username',
          'u.display_name',
          'u.avatar_url',
          'f.created_at as followed_since'
        );

      res.json({
        followers: rows.map(row => mapDbUser(row, { followed_since: row.followed_since }))
      });
    } catch (error) {
      console.error('Get followers error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.post('/follow/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const followingId = req.params.userId;

      if (followingId === req.userId) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
      }

      const targetUser = await db('users')
        .where({ id: followingId, is_banned: false })
        .first('id');

      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      const existing = await db('user_follows')
        .where({ follower_id: req.userId, following_id: followingId })
        .first();

      if (existing) {
        return res.status(400).json({ error: 'Already following this user' });
      }

      await db('user_follows').insert({
        follower_id:  req.userId,
        following_id: followingId
      });

      res.json({ message: 'User followed successfully' });
    } catch (error) {
      console.error('Follow user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.delete('/follow/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const followingId = req.params.userId;

      const deleted = await db('user_follows')
        .where({ follower_id: req.userId, following_id: followingId })
        .delete();

      if (!deleted) {
        return res.status(404).json({ error: 'Not following this user' });
      }

      res.json({ message: 'User unfollowed successfully' });
    } catch (error) {
      console.error('Unfollow user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  // Recent notable activity from the people you follow: things they finished
  // or rated. No reviews — just "who did what". Ordered newest first.
  router.get('/following/activity', verifyToken, checkBanned, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 40, 60);
      const rows = await db('user_follows as f')
        .join('user_game_lists as ugl', 'ugl.user_id', 'f.following_id')
        .join('games as g', 'g.id', 'ugl.game_id')
        .join('users as u', 'u.id', 'f.following_id')
        .where('f.follower_id', req.userId)
        .where('u.is_banned', false)
        .andWhere(function () {
          this.where('ugl.status', 'completed').orWhereNotNull('ugl.score');
        })
        .orderBy('ugl.updated_at', 'desc')
        .limit(limit)
        .select(
          'u.id as user_id',
          'u.username',
          'u.display_name',
          'u.avatar_url',
          'ugl.status',
          'ugl.score',
          'ugl.updated_at',
          'g.name',
          'g.background_image',
          'g.media_type',
          'g.game_id as media_ref'
        );

      res.json({
        activity: rows.map(r => ({
          user: {
            id: r.user_id,
            username: r.username || 'unknown',
            display_name: r.display_name || r.username || '',
            avatar_url: r.avatar_url || null
          },
          status: r.status,
          score: r.score,
          updated_at: r.updated_at,
          media: {
            name: r.name,
            background_image: r.background_image || null,
            media_type: r.media_type || 'game',
            media_ref: r.media_ref
          }
        }))
      });
    } catch (error) {
      console.error('Get following activity error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/follow/status/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;

      const [following, followsYou] = await Promise.all([
        db('user_follows')
          .where({ follower_id: req.userId, following_id: userId })
          .first(),
        db('user_follows')
          .where({ follower_id: userId, following_id: req.userId })
          .first()
      ]);

      res.json({
        isFollowing: !!following,
        followsYou:  !!followsYou
      });
    } catch (error) {
      console.error('Check follow status error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  return router;
};
