const express = require('express');
const taste = require('./taste');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, checkBanned) => {
  const router = express.Router();

  const CURRENT_LIMIT = 6;

  async function getPublicUser(userId) {
    try {
      const dbUser = await db('users').where({ id: userId }).first();
      if (!dbUser) return null;
      if (dbUser.is_banned) return null;
      return {
        id:           dbUser.id,
        username:     dbUser.username     || 'unknown',
        display_name: dbUser.display_name || dbUser.username || '',
        avatar_url:   dbUser.avatar_url   || null,
        bio:          dbUser.bio          || '',
        accent:       dbUser.accent       || null,
        banner_style: dbUser.banner_style || 'posters',
        is_private:   !!dbUser.is_private,
        created_at:   dbUser.created_at
      };
    } catch (_) {
      return null;
    }
  }

  // A user's Top 10s, grouped by category and already in rank order.
  async function getTopMedia(userId) {
    const rows = await db('user_top_media')
      .join('games as g', 'g.id', 'user_top_media.game_id')
      .where('user_top_media.user_id', userId)
      .orderBy('user_top_media.position')
      .select('user_top_media.media_type', 'user_top_media.position',
              'g.game_id', 'g.name', 'g.background_image', 'g.released');
    const out = { movie: [], series: [], anime: [], game: [] };
    for (const r of rows) {
      if (!out[r.media_type]) continue;
      out[r.media_type].push({
        position: Number(r.position), game_id: r.game_id,
        name: r.name, background_image: r.background_image, released: r.released
      });
    }
    return out;
  }

  /* What someone is currently into. Pinned titles win; with nothing pinned this
     falls back to whatever they have most recently touched, so the section is
     worth reading before anybody configures it. */
  async function getCurrentlyInto(userId) {
    const base = () => db('user_game_lists as ugl')
      .join('games as g', 'g.id', 'ugl.game_id')
      .where('ugl.user_id', userId)
      .where('ugl.status', 'playing')
      .select('g.game_id', 'g.name', 'g.background_image', 'g.media_type',
              'g.episode_count', 'ugl.progress', 'ugl.updated_at');

    const pinned = await base().where('ugl.show_on_profile', true)
      .orderBy('ugl.updated_at', 'desc').limit(CURRENT_LIMIT);
    if (pinned.length) return { items: pinned, pinned: true };

    const recent = await base().orderBy('ugl.updated_at', 'desc').limit(CURRENT_LIMIT);
    return { items: recent, pinned: false };
  }

  /* One pairwise Similar Taste score, cached briefly. The key is order
     independent because the score is symmetric, so two people looking at each
     other share the entry. */
  async function scoreAgainstViewer(viewerId, targetId) {
    if (!viewerId || !targetId || viewerId === targetId) return null;
    const key = 'pair:' + [String(viewerId), String(targetId)].sort().join(':');
    const cached = taste.cacheGet(key);
    if (cached !== undefined) return cached;

    const profiles = await taste.loadProfiles(db, [viewerId, targetId]);
    const result = taste.similarity(
      profiles.get(String(viewerId)) || { items: [], top: {}, genres: {} },
      profiles.get(String(targetId)) || { items: [], top: {}, genres: {} }
    );
    const value = result ? { percent: result.percent, shared: result.shared, coRated: result.coRated, topShared: result.topShared } : null;
    taste.cacheSet(key, value);
    return value;
  }

  router.get('/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;

      const user = await getPublicUser(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const isSelf = req.userId === userId;
      const [isFollowing, requested] = await Promise.all([
        db('user_follows').where({ follower_id: req.userId, following_id: userId }).first(),
        db('user_follow_requests').where({ requester_id: req.userId, target_id: userId }).first()
      ]);
      const canView = isSelf || !user.is_private || !!isFollowing;

      const [games, followers, following, breakdownRows] = await Promise.all([
        db('user_game_lists').where('user_id', userId).count('id as count').first(),
        db('user_follows').where('following_id', userId).count('* as count').first(),
        db('user_follows').where('follower_id',  userId).count('* as count').first(),
        db('user_game_lists')
          .leftJoin('games', 'games.id', 'user_game_lists.game_id')
          .where('user_game_lists.user_id', userId)
          .groupBy('games.media_type')
          .select('games.media_type', db.raw('COUNT(*) as count'))
      ]);

      const mediaBreakdown = { game: 0, movie: 0, series: 0, anime: 0 };
      (breakdownRows || []).forEach(r => {
        const key = r.media_type || 'game';
        if (mediaBreakdown[key] === undefined) mediaBreakdown[key] = 0;
        mediaBreakdown[key] += parseInt(r.count) || 0;
      });

      // A private library stays private: no Top 10, nothing currently into, and
      // no similarity score, since all three are derived from what they track.
      const [top, current, similar] = canView
        ? await Promise.all([
            getTopMedia(userId),
            getCurrentlyInto(userId),
            isSelf ? Promise.resolve(null) : scoreAgainstViewer(req.userId, userId)
          ])
        : [null, null, null];

      res.json({
        user: {
          ...user,
          isSelf,
          canView,
          isFollowing: !!isFollowing,
          requested:   !!requested,
          totalGames:     parseInt(games?.count)     || 0,
          mediaBreakdown: canView ? mediaBreakdown : { game: 0, movie: 0, series: 0, anime: 0 },
          followersCount: parseInt(followers?.count) || 0,
          followingCount: parseInt(following?.count) || 0
        },
        top,
        currentlyInto: current,
        // null means "not enough data yet" rather than a number nobody can trust.
        similarity: similar
      });
    } catch (error) {
      console.error('Get user profile error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/:userId/games', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;

      const user = await getPublicUser(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      // Private libraries are only visible to the owner and accepted followers.
      if (user.is_private && req.userId !== userId) {
        const follows = await db('user_follows')
          .where({ follower_id: req.userId, following_id: userId }).first();
        if (!follows) return res.status(403).json({ error: 'This account is private', private: true });
      }

      // Game metadata lives on `games`, not `user_game_lists` (which only holds
      // status/score/progress). Reading name/artwork/etc. from user_game_lists
      // was throwing "column game_name does not exist" → the collection hung.
      const games = await db('user_game_lists')
        .leftJoin('games', 'games.id', 'user_game_lists.game_id')
        .where('user_game_lists.user_id', userId)
        .select(
          db.raw(`COALESCE(games.game_id, user_game_lists.game_id::text) as id`),
          db.raw(`COALESCE(games.media_type, 'game') as media_type`),
          'games.name as name',
          'games.background_image',
          'games.rating',
          'games.description',
          'games.released',
          'games.metacritic_score',
          'games.playtime',
          'user_game_lists.status',
          'user_game_lists.score',
          'user_game_lists.notes',
          'user_game_lists.progress_hours',
          'user_game_lists.created_at as date_added',
          'user_game_lists.updated_at'
        )
        .orderBy('user_game_lists.updated_at', 'desc');

      res.json({ games });
    } catch (error) {
      console.error('Get user games error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/:userId/followers', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;
      const user = await getPublicUser(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const rows = await db('user_follows')
        .where('following_id', userId)
        .orderBy('created_at', 'desc')
        .select('follower_id');

      const followers = (
        await Promise.all(rows.map(r => getPublicUser(r.follower_id)))
      ).filter(Boolean);

      res.json({ followers });
    } catch (error) {
      console.error('Get user followers error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/:userId/following', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;
      const user = await getPublicUser(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const rows = await db('user_follows')
        .where('follower_id', userId)
        .orderBy('created_at', 'desc')
        .select('following_id');

      const following = (
        await Promise.all(rows.map(r => getPublicUser(r.following_id)))
      ).filter(Boolean);

      res.json({ following });
    } catch (error) {
      console.error('Get user following error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/:userId/lists', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;
      const user = await getPublicUser(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      if (user.is_private && req.userId !== userId) {
        const follows = await db('user_follows')
          .where({ follower_id: req.userId, following_id: userId }).first();
        if (!follows) return res.status(403).json({ error: 'This account is private', private: true });
      }

      const lists = await db('custom_lists')
        .where({ user_id: userId, is_public: true })
        .orderBy('created_at', 'desc');

      if (lists.length === 0) return res.json({ lists: [] });

      const listIds = lists.map(l => l.id);
      const counts  = await db('custom_list_games')
        .whereIn('list_id', listIds)
        .groupBy('list_id')
        .select('list_id', db.raw('COUNT(*) as game_count'));

      const countMap = {};
      counts.forEach(c => { countMap[c.list_id] = parseInt(c.game_count) || 0; });

      res.json({
        lists: lists.map(l => ({ ...l, game_count: countMap[l.id] || 0 }))
      });
    } catch (error) {
      console.error('Get user public lists error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.get('/:userId/lists/:listId', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;
      const listId = parseInt(req.params.listId);

      const user = await getPublicUser(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const list = await db('custom_lists')
        .where({ id: listId, user_id: userId, is_public: true })
        .first();
      if (!list) return res.status(404).json({ error: 'List not found or is private' });

      const games = await db('custom_list_games')
        .leftJoin('games', 'games.id', 'custom_list_games.game_id')
        .where('custom_list_games.list_id', list.id)
        .orderBy('custom_list_games.position', 'asc')
        .select(
          'custom_list_games.id as list_entry_id',
          db.raw(`COALESCE(games.game_id, custom_list_games.game_id::text) as game_id`),
          'custom_list_games.note',
          'custom_list_games.position',
          'custom_list_games.added_at',
          'custom_list_games.status',
          'custom_list_games.score as user_score',
          'games.name as name',
          'games.background_image',
          'games.media_type',
          'games.rating',
          'games.released',
          'games.metacritic_score'
        );

      res.json({
        list: {
          ...list,
          games: games.map(g => ({ ...g, genres: [] }))
        }
      });
    } catch (error) {
      console.error('Get user public list detail error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  return router;
};