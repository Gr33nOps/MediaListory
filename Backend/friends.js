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
      is_private:   !!row.is_private,
      ...extra
    };
  }

  // Attach my relationship to each listed user: following / requested / none.
  async function decorateRelationship(meId, rows) {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const [following, requested] = await Promise.all([
      db('user_follows').where('follower_id', meId).whereIn('following_id', ids).select('following_id'),
      db('user_follow_requests').where('requester_id', meId).whereIn('target_id', ids).select('target_id')
    ]);
    const fset = new Set(following.map(r => r.following_id));
    const rset = new Set(requested.map(r => r.target_id));
    return rows.map(r => mapDbUser(r, {
      relationship: fset.has(r.id) ? 'following' : (rset.has(r.id) ? 'requested' : 'none')
    }));
  }

  router.get('/users/search', verifyToken, checkBanned, async (req, res) => {
    try {
      const { query } = req.query;
      if (!query || query.trim().length < 2) return res.json({ users: [] });
      const searchTerm = `%${query.trim().toLowerCase()}%`;

      const rows = await db('users')
        .where('is_banned', false)
        .whereNot('id', req.userId)
        .andWhere(function () {
          this.whereRaw('LOWER(username) LIKE ?', [searchTerm])
            .orWhereRaw('LOWER(COALESCE(display_name, \'\')) LIKE ?', [searchTerm]);
        })
        .orderBy('username', 'asc')
        .limit(15)
        .select('id', 'username', 'display_name', 'avatar_url', 'is_private');

      res.json({ users: await decorateRelationship(req.userId, rows) });
    } catch (error) {
      console.error('Search users error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  // People discovery: every account (public accounts are directly followable,
  // private accounts show a Request button), minus yourself and banned users.
  router.get('/discover', verifyToken, checkBanned, async (req, res) => {
    try {
      const rows = await db('users')
        .where('is_banned', false)
        .whereNot('id', req.userId)
        .orderBy('created_at', 'desc')
        .limit(60)
        .select('id', 'username', 'display_name', 'avatar_url', 'is_private');
      res.json({ users: await decorateRelationship(req.userId, rows) });
    } catch (error) {
      console.error('Discover users error:', error);
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
        .select('u.id', 'u.username', 'u.display_name', 'u.avatar_url', 'u.is_private', 'f.created_at as followed_since');
      res.json({ following: rows.map(row => mapDbUser(row, { followed_since: row.followed_since, relationship: 'following' })) });
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
        .select('u.id', 'u.username', 'u.display_name', 'u.avatar_url', 'u.is_private', 'f.created_at as followed_since');
      res.json({ followers: await decorateRelationship(req.userId, rows) });
    } catch (error) {
      console.error('Get followers error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  // Incoming follow requests (people who want to follow my private account).
  router.get('/follow/requests', verifyToken, checkBanned, async (req, res) => {
    try {
      const rows = await db('user_follow_requests as r')
        .join('users as u', 'r.requester_id', 'u.id')
        .where('r.target_id', req.userId)
        .where('u.is_banned', false)
        .orderBy('r.created_at', 'desc')
        .select('u.id', 'u.username', 'u.display_name', 'u.avatar_url', 'u.is_private', 'r.created_at as requested_at');
      res.json({ requests: rows.map(row => mapDbUser(row, { requested_at: row.requested_at })) });
    } catch (error) {
      console.error('Get follow requests error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.post('/follow/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const targetId = req.params.userId;
      if (targetId === req.userId) return res.status(400).json({ error: 'Cannot follow yourself' });

      const target = await db('users').where({ id: targetId, is_banned: false }).first('id', 'is_private');
      if (!target) return res.status(404).json({ error: 'User not found' });

      const existing = await db('user_follows')
        .where({ follower_id: req.userId, following_id: targetId }).first();
      if (existing) return res.status(400).json({ error: 'Already following this user', status: 'following' });

      if (target.is_private) {
        const pending = await db('user_follow_requests')
          .where({ requester_id: req.userId, target_id: targetId }).first();
        if (pending) return res.status(400).json({ error: 'Request already sent', status: 'requested' });
        await db('user_follow_requests').insert({ requester_id: req.userId, target_id: targetId });
        return res.json({ message: 'Follow request sent', status: 'requested' });
      }

      await db('user_follows').insert({ follower_id: req.userId, following_id: targetId });
      res.json({ message: 'User followed successfully', status: 'following' });
    } catch (error) {
      console.error('Follow user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.delete('/follow/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const targetId = req.params.userId;
      // Unfollow, or cancel a pending request — whichever exists.
      const deletedFollow = await db('user_follows')
        .where({ follower_id: req.userId, following_id: targetId }).delete();
      const deletedReq = await db('user_follow_requests')
        .where({ requester_id: req.userId, target_id: targetId }).delete();
      if (!deletedFollow && !deletedReq) return res.status(404).json({ error: 'Not following this user' });
      res.json({ message: 'Unfollowed', status: 'none' });
    } catch (error) {
      console.error('Unfollow user error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.post('/follow/requests/:requesterId/accept', verifyToken, checkBanned, async (req, res) => {
    try {
      const requesterId = req.params.requesterId;
      const reqRow = await db('user_follow_requests')
        .where({ requester_id: requesterId, target_id: req.userId }).first();
      if (!reqRow) return res.status(404).json({ error: 'Request not found' });
      await db('user_follows')
        .insert({ follower_id: requesterId, following_id: req.userId })
        .onConflict(['follower_id', 'following_id']).ignore();
      await db('user_follow_requests').where({ id: reqRow.id }).delete();
      res.json({ message: 'Request accepted' });
    } catch (error) {
      console.error('Accept request error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.post('/follow/requests/:requesterId/reject', verifyToken, checkBanned, async (req, res) => {
    try {
      const deleted = await db('user_follow_requests')
        .where({ requester_id: req.params.requesterId, target_id: req.userId }).delete();
      if (!deleted) return res.status(404).json({ error: 'Request not found' });
      res.json({ message: 'Request rejected' });
    } catch (error) {
      console.error('Reject request error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/follow/status/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;
      const [following, followsYou, requested, target] = await Promise.all([
        db('user_follows').where({ follower_id: req.userId, following_id: userId }).first(),
        db('user_follows').where({ follower_id: userId, following_id: req.userId }).first(),
        db('user_follow_requests').where({ requester_id: req.userId, target_id: userId }).first(),
        db('users').where({ id: userId }).first('is_private')
      ]);
      res.json({
        isFollowing: !!following,
        followsYou:  !!followsYou,
        requested:   !!requested,
        isPrivate:   !!(target && target.is_private)
      });
    } catch (error) {
      console.error('Check follow status error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  return router;
};
