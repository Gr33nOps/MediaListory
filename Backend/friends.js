const express = require('express');
const taste = require('./taste');
const avatars = require('./avatars');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, checkBanned) => {
  const router = express.Router();

  // req is needed to build absolute avatar URLs; see avatars.js for why the data
  // URI is no longer inlined into any of these list responses.
  function mapDbUser(row, extra = {}, req = null) {
    return {
      id:           row.id,
      username:     row.username || 'unknown',
      display_name: row.display_name || row.username || '',
      avatar_url:   avatars.urlFor(req, row),
      is_private:   !!row.is_private,
      ...extra
    };
  }

  // Attach my relationship to each listed user: following / requested / none.
  async function decorateRelationship(meId, rows, req) {
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
    }, req));
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
        .select('id', 'username', 'display_name', 'is_private', ...avatars.columns(db, 'users'));

      res.json({ users: await decorateRelationship(req.userId, rows, req) });
    } catch (error) {
      console.error('Search users error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  // People discovery: every account (public accounts are directly followable,
  // private accounts show a Request button), minus yourself and banned users.
  /* Activity from the people you follow.

     Following is the permission: a private account only gains a follower after
     approving the request, so anyone whose rows appear here has already let this
     viewer see their library. No extra privacy check is needed beyond the join.

     user_game_lists is updated in place rather than appended to, so updated_at is
     the closest thing to an event time the schema has. That means one row per
     title per person, showing its latest state, which is what a feed of "what
     they are up to" wants anyway. Planned titles are left out: adding something
     to a watchlist is not news. */
  router.get('/following/activity', verifyToken, checkBanned, async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const rows = await db('user_game_lists as ugl')
        .join('users as u', 'u.id', 'ugl.user_id')
        .join('games as g', 'g.id', 'ugl.game_id')
        .whereIn('ugl.user_id', db('user_follows').where('follower_id', req.userId).select('following_id'))
        .where('u.is_banned', false)
        .where(function () {
          this.whereIn('ugl.status', ['completed', 'playing']).orWhereNotNull('ugl.score');
        })
        .orderBy('ugl.updated_at', 'desc')
        .limit(limit)
        .select(
          'ugl.status', 'ugl.score', 'ugl.progress', 'ugl.updated_at',
          'u.id as user_id', 'u.username', 'u.display_name',
          ...avatars.columns(db, 'u'),
          'g.name', 'g.media_type', 'g.game_id as media_ref',
          'g.background_image', 'g.episode_count'
        );

      res.json({
        activity: rows.map(r => ({
          user: {
            id: r.user_id, username: r.username,
            display_name: r.display_name || r.username,
            avatar_url: avatars.urlFor(req, { id: r.user_id, avatar_remote: r.avatar_remote, avatar_uploaded: r.avatar_uploaded, avatar_version: r.avatar_version })
          },
          status: r.status,
          score: r.score == null ? null : Number(r.score),
          progress: r.progress == null ? null : Number(r.progress),
          updated_at: r.updated_at,
          media: {
            name: r.name, media_type: r.media_type || 'game', media_ref: r.media_ref,
            background_image: r.background_image,
            episode_count: r.episode_count == null ? null : Number(r.episode_count)
          }
        }))
      });
    } catch (error) {
      console.error('Following activity error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  /* People with similar taste.

     Scoring everybody would mean reading every library on every request, so this
     shortlists on shared titles in SQL first and only scores that shortlist. The
     result is cached for a few minutes because it moves slowly: it changes when
     somebody rates or ranks something, not when they open a page.

     Private accounts are left out unless you already follow them. Their Top 10,
     ratings, and library are all hidden from you, so putting a number on how much
     you have in common would leak the thing privacy is meant to cover. */
  router.get('/discover/similar', verifyToken, checkBanned, async (req, res) => {
    try {
      const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 8));
      const key = 'similar:' + req.userId;

      /* Only the scores are cached, never who may see them. Visibility is
         re-read below on every request: caching it would keep somebody in other
         people's suggestions for the rest of the TTL after they went private,
         still showing how much taste they share. */
      let scores = taste.cacheGet(key);
      if (scores === undefined) {
        const candidateIds = await taste.findCandidates(db, req.userId, 40);
        const profiles = candidateIds.length
          ? await taste.loadProfiles(db, [req.userId, ...candidateIds])
          : new Map();
        const mine = profiles.get(String(req.userId));

        scores = [];
        for (const id of candidateIds) {
          const theirs = profiles.get(id);
          if (!mine || !theirs) continue;
          const score = taste.similarity(mine, theirs);
          if (!score) continue; // not enough between us to put a number on
          scores.push({ id, percent: score.percent, shared: score.shared, topShared: score.topShared, coRated: score.coRated });
        }
        scores.sort((a, b) => b.percent - a.percent || b.shared - a.shared);
        taste.cacheSet(key, scores);
      }
      if (!scores.length) return res.json({ users: [] });

      const [rows, following] = await Promise.all([
        db('users').whereIn('id', scores.map(s => s.id)).where('is_banned', false)
          .select('id', 'username', 'display_name', 'is_private', ...avatars.columns(db, 'users')),
        db('user_follows').where('follower_id', req.userId).select('following_id')
      ]);
      const followed = new Set(following.map(r => String(r.following_id)));
      const byId = new Map(rows.map(r => [String(r.id), r]));

      const page = [];
      for (const s of scores) {
        const row = byId.get(s.id);
        // Banned, deleted, or private-and-not-followed: not for this viewer.
        if (!row) continue;
        if (row.is_private && !followed.has(s.id)) continue;
        page.push({ row, similarity: { percent: s.percent, shared: s.shared, topShared: s.topShared, coRated: s.coRated } });
        if (page.length >= limit) break;
      }
      if (!page.length) return res.json({ users: [] });

      // decorateRelationship preserves order, so the scores line back up by index.
      const decorated = await decorateRelationship(req.userId, page.map(p => p.row), req);
      res.json({ users: decorated.map((u, i) => ({ ...u, similarity: page[i].similarity })) });
    } catch (error) {
      console.error('Similar taste discovery error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/discover', verifyToken, checkBanned, async (req, res) => {
    try {
      const sort = String(req.query.sort || 'recent');
      let q = db('users as u')
        .where('u.is_banned', false)
        .whereNot('u.id', req.userId)
        .limit(60)
        .select('u.id', 'u.username', 'u.display_name', 'u.is_private', ...avatars.columns(db, 'u'));

      if (sort === 'active') {
        // "Most active" ~= level: the more titles tracked, the higher the level.
        q = q.select(db.raw('(SELECT count(*) FROM user_game_lists ugl WHERE ugl.user_id = u.id) as game_count'))
             .orderBy('game_count', 'desc')
             .orderBy('u.created_at', 'desc');
      } else if (sort === 'name_asc') {
        q = q.orderByRaw('LOWER(COALESCE(u.display_name, u.username)) asc');
      } else if (sort === 'name_desc') {
        q = q.orderByRaw('LOWER(COALESCE(u.display_name, u.username)) desc');
      } else {
        q = q.orderBy('u.created_at', 'desc'); // recent (default)
      }

      const rows = await q;
      res.json({ users: await decorateRelationship(req.userId, rows, req) });
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
        .select('u.id', 'u.username', 'u.display_name', 'u.is_private', 'f.created_at as followed_since', ...avatars.columns(db, 'u'));
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
        .select('u.id', 'u.username', 'u.display_name', 'u.is_private', 'f.created_at as followed_since', ...avatars.columns(db, 'u'));
      res.json({ followers: await decorateRelationship(req.userId, rows, req) });
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
        .select('u.id', 'u.username', 'u.display_name', 'u.is_private', 'r.created_at as requested_at', ...avatars.columns(db, 'u'));
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
      // Unfollow, or cancel a pending request - whichever exists.
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
