const express = require('express');
const { getSupabaseAdmin } = require('./supabaseAdmin');
const { clientError } = require('./errors');

module.exports = (db, verifyToken, checkBanned) => {
  const router = express.Router();

  const supabaseAdmin = getSupabaseAdmin();

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
        created_at:   dbUser.created_at
      };
    } catch (_) {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      const u    = data.user;
      const meta = u.user_metadata || {};
      if (meta.is_banned) return null;
      return {
        id:           u.id,
        username:     meta.username     || u.email?.split('@')[0] || 'unknown',
        display_name: meta.display_name || meta.username          || '',
        avatar_url:   meta.avatar_url   || null,
        created_at:   u.created_at
      };
    }
  }

  router.get('/:userId', verifyToken, checkBanned, async (req, res) => {
    try {
      const userId = req.params.userId;

      const user = await getPublicUser(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });

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

      const mediaBreakdown = { game: 0, movie: 0, series: 0 };
      (breakdownRows || []).forEach(r => {
        const key = r.media_type || 'game';
        if (mediaBreakdown[key] === undefined) mediaBreakdown[key] = 0;
        mediaBreakdown[key] += parseInt(r.count) || 0;
      });

      res.json({
        user: {
          ...user,
          totalGames:     parseInt(games?.count)     || 0,
          mediaBreakdown,
          followersCount: parseInt(followers?.count) || 0,
          followingCount: parseInt(following?.count) || 0
        }
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

      const games = await db('user_game_lists')
        .leftJoin('games', 'games.id', 'user_game_lists.game_id')
        .where('user_game_lists.user_id', userId)
        .select(
          db.raw(`COALESCE(games.game_id, user_game_lists.game_id::text) as id`),
          db.raw(`COALESCE(games.media_type, 'game') as media_type`),
          'user_game_lists.game_name as name',
          db.raw(`COALESCE(
            NULLIF(user_game_lists.background_image, ''),
            games.background_image
          ) as background_image`),
          'user_game_lists.rating',
          'user_game_lists.description',
          'user_game_lists.released',
          'user_game_lists.metacritic_score',
          'user_game_lists.playtime',
          'user_game_lists.status',
          'user_game_lists.score',
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
          'custom_list_games.game_name as name',
          db.raw(`COALESCE(
            NULLIF(custom_list_games.background_image, ''),
            games.background_image
          ) as background_image`),
          'custom_list_games.rating',
          'custom_list_games.released',
          'custom_list_games.metacritic_score'
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