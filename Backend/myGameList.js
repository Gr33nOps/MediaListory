const express = require('express');
const { clientError } = require('./errors');
const { parseIgdbClientId, slugify } = require('./igdbUtils');
const { parseMediaRef, externalRef, isValidMediaType, providerFor } = require('./tmdbUtils');

module.exports = (db, verifyToken, checkBanned) => {
  const router = express.Router();

  function generateSlug(name) {
    return slugify(name);
  }

  function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try { return JSON.parse(value || '[]'); } catch (_) { return []; }
    }
    return value || [];
  }

  // Resolve the media identity from an add/list payload. Supports games (IGDB),
  // movies/series (TMDB), and anime (Kitsu). Returns
  // { media_type, provider, external_id, ref } or null. IDs are kept separate per
  // provider + media_type so they can never collide.
  function resolveMedia(data) {
    if (!data) return null;

    // Explicit non-game media (movies/series -> TMDB, anime -> Kitsu).
    if (data.media_type && isValidMediaType(data.media_type) && data.media_type !== 'game') {
      const raw = data.provider_id != null ? data.provider_id
        : (data.tmdb_id != null ? data.tmdb_id : data.kitsu_id);
      const id = parseInt(raw, 10);
      if (id > 0) {
        return {
          media_type: data.media_type,
          provider: providerFor(data.media_type),
          external_id: id,
          ref: externalRef(data.media_type, id)
        };
      }
    }

    // Games via IGDB (default / backward compatible).
    const igdbId = parseIgdbClientId(data.igdb_id) || parseIgdbClientId(data.game_id);
    if (igdbId) {
      return { media_type: 'game', provider: 'igdb', external_id: igdbId, ref: `igdb_${igdbId}` };
    }

    // Fallback: parse a universal ref string.
    const parsed = parseMediaRef(data.game_id);
    if (parsed) {
      return {
        media_type: parsed.media_type,
        provider: providerFor(parsed.media_type),
        external_id: parsed.id,
        ref: externalRef(parsed.media_type, parsed.id)
      };
    }
    return null;
  }

  // JSON columns on `games` are the source of truth for metadata.
  // The `games` table holds every media kind, discriminated by `media_type`.
  // `game_id` (text) is the universal external ref and the upsert key.
  async function ensureMediaExists(mediaData) {
    try {
      const media = resolveMedia(mediaData);
      if (!media) {
        const err = new Error('A valid igdb_id (game) or media_type + tmdb_id (movie/series) is required');
        err.status = 400;
        throw err;
      }
      if (!mediaData?.name) {
        const err = new Error('Title is required');
        err.status = 400;
        throw err;
      }

      const existing = await db('games').where({ game_id: media.ref }).first();
      if (existing) return existing.id;

      const slug = generateSlug(mediaData.name) || media.ref;
      const payload = {
        game_id:          media.ref,
        igdb_id:          media.provider === 'igdb' ? media.external_id : null,
        tmdb_id:          media.provider === 'tmdb' ? media.external_id : null,
        provider:         media.provider,
        provider_id:      String(media.external_id),
        media_type:       media.media_type,
        name:             mediaData.name,
        slug,
        description:      mediaData.description       || null,
        background_image: mediaData.background_image  || null,
        rating:           mediaData.rating            || null,
        metacritic_score: mediaData.metacritic_score  || null,
        released:         mediaData.released          || null,
        episode_count:    (mediaData.number_of_episodes != null ? mediaData.number_of_episodes
                            : (mediaData.episode_count != null ? mediaData.episode_count : null)),
        playtime:         mediaData.playtime          || 0,
        genres:           JSON.stringify(mediaData.genres     || []),
        platforms:        JSON.stringify(mediaData.platforms  || []),
        publishers:       JSON.stringify(mediaData.publishers || []),
        developers:       JSON.stringify(mediaData.developers || []),
      };

      try {
        const [row] = await db('games').insert(payload).onConflict('game_id').ignore().returning('id');
        if (row) return row.id ?? row;
        const raced = await db('games').where({ game_id: media.ref }).first();
        if (!raced) throw new Error('Failed to persist media');
        return raced.id;
      } catch (insertErr) {
        const raced = await db('games').where({ game_id: media.ref }).first();
        if (raced) return raced.id;
        const [row] = await db('games').insert({
          ...payload,
          slug: `${slug}-${media.external_id}`
        }).returning('id');
        return row.id ?? row;
      }
    } catch (error) {
      console.error('Error ensuring media exists:', error);
      throw error;
    }
  }

  async function getUniqueListSlug(userId, name, excludeId = null) {
    let slug = generateSlug(name) || 'list';
    let candidate = slug;
    let counter = 1;
    while (true) {
      let query = db('custom_lists').where({ user_id: userId, slug: candidate });
      if (excludeId) query = query.whereNot({ id: excludeId });
      const existing = await query.first();
      if (!existing) return candidate;
      candidate = `${slug}-${counter++}`;
    }
  }

  router.post('/games', verifyToken, checkBanned, async (req, res) => {
    try {
      const { game_id, game_data, status, score } = req.body;
      let dbGameId;

      if (game_data) {
        dbGameId = await ensureMediaExists(game_data);
      } else if (game_id && /^(igdb_|tmdb_)/.test(game_id.toString())) {
        return res.status(400).json({ error: 'Media data required for catalog items' });
      } else {
        dbGameId = game_id;
      }

      const existing = await db('user_game_lists')
        .where({ user_id: req.userId, game_id: dbGameId })
        .first();
      if (existing) return res.status(400).json({ error: 'Game already in your list', game_id: dbGameId });

      await db('user_game_lists').insert({
        user_id: req.userId,
        game_id: dbGameId,
        status:  status || 'plan_to_play',
        score:   score  || null
      });

      res.status(201).json({ message: 'Game added successfully', game_id: dbGameId });
    } catch (error) {
      console.error('Add game error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/games', verifyToken, checkBanned, async (req, res) => {
    try {
      const { status, sort = 'added_date', order = 'desc', media_type } = req.query;
      const sortOrder = order.toLowerCase() === 'asc' ? 'asc' : 'desc';

      let query = db('user_game_lists')
        .join('games', 'user_game_lists.game_id', 'games.id')
        .where('user_game_lists.user_id', req.userId)
        .select(
          'user_game_lists.*',
          'games.name',
          'games.background_image',
          'games.rating',
          'games.description',
          'games.released',
          'games.metacritic_score',
          'games.playtime',
          'games.media_type',
          'games.provider',
          'games.igdb_id',
          'games.tmdb_id',
          'games.episode_count',
          'games.game_id as media_ref',
          'games.genres as genres_json',
          'games.platforms as platforms_json',
          'games.publishers as publishers_json',
          'games.developers as developers_json'
        );

      if (status) query = query.where('user_game_lists.status', status);
      if (media_type && isValidMediaType(media_type)) {
        query = query.where('games.media_type', media_type);
      }

      switch (sort) {
        case 'name':   query = query.orderBy('games.name', sortOrder); break;
        case 'rating': query = query.orderBy('games.rating', sortOrder); break;
        case 'score':  query = query.orderBy('user_game_lists.score', sortOrder); break;
        default:       query = query.orderBy('user_game_lists.created_at', sortOrder); break;
      }

      const userGames = await query;
      if (userGames.length === 0) return res.json({ games: [] });

      // Metadata lives in JSON columns on `games` (source of truth for every media type).
      userGames.forEach(game => {
        game.media_type = game.media_type || 'game';
        game.genres     = parseJsonArray(game.genres_json);
        game.platforms  = parseJsonArray(game.platforms_json);
        game.publishers = parseJsonArray(game.publishers_json);
        game.developers = parseJsonArray(game.developers_json);
        delete game.genres_json;
        delete game.platforms_json;
        delete game.publishers_json;
        delete game.developers_json;
      });

      res.json({ games: userGames });
    } catch (error) {
      console.error('Get user games error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.put('/games/:gameId', verifyToken, checkBanned, async (req, res) => {
    try {
      const { status, score, progress } = req.body;
      const userGame = await db('user_game_lists')
        .where({ user_id: req.userId, game_id: req.params.gameId })
        .first();
      if (!userGame) return res.status(404).json({ error: 'Game not found in your list' });

      const update = {
        status:     status !== undefined ? status : userGame.status,
        score:      score  !== undefined ? score  : userGame.score,
        updated_at: db.fn.now()
      };
      // Episode/step progress (series/anime). Clamp to >= 0.
      if (progress !== undefined) {
        const p = parseInt(progress, 10);
        update.progress = Number.isNaN(p) ? null : Math.max(0, p);
      }

      await db('user_game_lists')
        .where({ user_id: req.userId, game_id: req.params.gameId })
        .update(update);

      res.json({ message: 'Game updated successfully' });
    } catch (error) {
      console.error('Update game error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.delete('/games/:gameId', verifyToken, checkBanned, async (req, res) => {
    try {
      const deleted = await db('user_game_lists')
        .where({ user_id: req.userId, game_id: req.params.gameId })
        .del();
      if (!deleted) return res.status(404).json({ error: 'Game not found in your list' });
      res.json({ message: 'Game removed successfully' });
    } catch (error) {
      console.error('Delete game error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/stats', verifyToken, checkBanned, async (req, res) => {
    try {
      const stats = await db('user_game_lists')
        .where('user_id', req.userId)
        .select(
          db.raw('COUNT(*) as total_games'),
          db.raw(`COUNT(CASE WHEN status = 'completed'    THEN 1 END) as completed`),
          db.raw(`COUNT(CASE WHEN status = 'playing'      THEN 1 END) as playing`),
          db.raw(`COUNT(CASE WHEN status = 'plan_to_play' THEN 1 END) as plan_to_play`),
          db.raw(`COUNT(CASE WHEN status = 'on_hold'      THEN 1 END) as on_hold`),
          db.raw(`COUNT(CASE WHEN status = 'dropped'      THEN 1 END) as dropped`),
          db.raw('ROUND(AVG(CASE WHEN score IS NOT NULL THEN score END)::numeric, 2) as mean_score')
        )
        .first();

      res.json({
        total_games:  parseInt(stats.total_games)  || 0,
        completed:    parseInt(stats.completed)    || 0,
        playing:      parseInt(stats.playing)      || 0,
        plan_to_play: parseInt(stats.plan_to_play) || 0,
        on_hold:      parseInt(stats.on_hold)      || 0,
        dropped:      parseInt(stats.dropped)      || 0,
        mean_score:   stats.mean_score ? parseFloat(stats.mean_score) : null
      });
    } catch (error) {
      console.error('Get stats error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/lists', verifyToken, checkBanned, async (req, res) => {
    try {
      const lists = await db('custom_lists')
        .where({ user_id: req.userId })
        .orderBy('created_at', 'desc');

      if (lists.length === 0) return res.json({ lists: [] });

      const listIds = lists.map(l => l.id);

      const [counts, covers] = await Promise.all([
        db('custom_list_games')
          .whereIn('list_id', listIds)
          .groupBy('list_id')
          .select('list_id', db.raw('COUNT(*) as game_count')),

        db('custom_list_games')
          .join('games', 'custom_list_games.game_id', 'games.id')
          .whereIn('custom_list_games.list_id', listIds)
          .whereNotNull('games.background_image')
          .orderBy('custom_list_games.position', 'asc')
          .select('custom_list_games.list_id', 'games.background_image')
      ]);

      const coversByList = {};
      covers.forEach(c => {
        if (!coversByList[c.list_id]) coversByList[c.list_id] = [];
        if (coversByList[c.list_id].length < 4) coversByList[c.list_id].push(c.background_image);
      });

      const countMap = {};
      counts.forEach(c => { countMap[c.list_id] = parseInt(c.game_count) || 0; });

      res.json({
        lists: lists.map(l => ({
          ...l,
          game_count:   countMap[l.id] || 0,
          cover_images: coversByList[l.id] || []
        }))
      });
    } catch (error) {
      console.error('Get custom lists error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.get('/lists/:listId', verifyToken, checkBanned, async (req, res) => {
    try {
      const list = await db('custom_lists').where({ id: req.params.listId }).first();
      if (!list) return res.status(404).json({ error: 'List not found' });
      if (list.user_id !== req.userId && !list.is_public)
        return res.status(403).json({ error: 'This list is private' });

      const games = await db('custom_list_games')
        .join('games', 'custom_list_games.game_id', 'games.id')
        .where('custom_list_games.list_id', list.id)
        .orderBy('custom_list_games.position', 'asc')
        .select(
          'custom_list_games.id as list_entry_id',
          'custom_list_games.game_id',
          'custom_list_games.note',
          'custom_list_games.position',
          'custom_list_games.added_at',
          'custom_list_games.status',
          'custom_list_games.score as user_score',
          'games.name',
          'games.background_image',
          'games.rating',
          'games.released',
          'games.metacritic_score',
          'games.media_type',
          'games.igdb_id',
          'games.tmdb_id',
          'games.game_id as media_ref',
          'games.genres as genres_json',
          'games.slug as game_slug'
        );

      res.json({
        list: {
          ...list,
          games: games.map(g => {
            const genres = parseJsonArray(g.genres_json).map(x => (x && x.name) ? x.name : x).filter(Boolean);
            const item = { ...g, media_type: g.media_type || 'game', genres };
            delete item.genres_json;
            return item;
          })
        }
      });
    } catch (error) {
      console.error('Get list detail error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.post('/lists', verifyToken, checkBanned, async (req, res) => {
    try {
      const { name, description, cover_color, is_public } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'List name is required' });
      if (name.trim().length > 100) return res.status(400).json({ error: 'List name must be 100 characters or less' });
      const category = ['movie', 'series', 'anime', 'game'].includes(req.body.category) ? req.body.category : null;

      const countResult = await db('custom_lists')
        .where({ user_id: req.userId })
        .count('id as cnt')
        .first();
      if (parseInt(countResult.cnt) >= 50) return res.status(400).json({ error: 'You can have at most 50 custom lists' });

      const slug = await getUniqueListSlug(req.userId, name.trim());

      const [row] = await db('custom_lists').insert({
        user_id:     req.userId,
        name:        name.trim(),
        slug,
        description: description ? description.trim() : null,
        cover_color: cover_color || '#3a7bd5',
        is_public:   is_public !== undefined ? Boolean(is_public) : true,
        category
      }).returning('id');

      const listId = row.id ?? row;
      const newList = await db('custom_lists').where({ id: listId }).first();
      res.status(201).json({ list: { ...newList, game_count: 0, cover_images: [] } });
    } catch (error) {
      console.error('Create list error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.put('/lists/:listId', verifyToken, checkBanned, async (req, res) => {
    try {
      const list = await db('custom_lists')
        .where({ id: req.params.listId, user_id: req.userId })
        .first();
      if (!list) return res.status(404).json({ error: 'List not found' });

      const { name, description, cover_color, is_public } = req.body;
      const updates = {};

      if (name !== undefined) {
        if (!name.trim()) return res.status(400).json({ error: 'List name cannot be empty' });
        if (name.trim().length > 100) return res.status(400).json({ error: 'List name must be 100 characters or less' });
        updates.name = name.trim();
        updates.slug = await getUniqueListSlug(req.userId, name.trim(), list.id);
      }
      if (description !== undefined) updates.description = description ? description.trim() : null;
      if (cover_color  !== undefined) updates.cover_color = cover_color;
      if (is_public    !== undefined) updates.is_public   = Boolean(is_public);
      if (req.body.category !== undefined) updates.category = ['movie', 'series', 'anime', 'game'].includes(req.body.category) ? req.body.category : null;

      await db('custom_lists').where({ id: list.id }).update(updates);
      const updated = await db('custom_lists').where({ id: list.id }).first();
      res.json({ list: updated });
    } catch (error) {
      console.error('Update list error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.delete('/lists/:listId', verifyToken, checkBanned, async (req, res) => {
    try {
      const deleted = await db('custom_lists')
        .where({ id: req.params.listId, user_id: req.userId })
        .del();
      if (!deleted) return res.status(404).json({ error: 'List not found' });
      res.json({ message: 'List deleted successfully' });
    } catch (error) {
      console.error('Delete list error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.post('/lists/:listId/games', verifyToken, checkBanned, async (req, res) => {
    try {
      const list = await db('custom_lists')
        .where({ id: req.params.listId, user_id: req.userId })
        .first();
      if (!list) return res.status(404).json({ error: 'List not found' });

      const { game_id, game_data, note, status, score } = req.body;
      if (!game_id && !game_data) return res.status(400).json({ error: 'game_id or game_data is required' });

      if (score !== undefined && score !== null && (score < 1 || score > 10)) {
        return res.status(400).json({ error: 'Score must be between 1 and 10' });
      }
      const validStatuses = ['playing', 'completed', 'plan_to_play', 'on_hold', 'dropped'];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
      }

      let dbGameId;
      if (game_data) {
        dbGameId = await ensureMediaExists(game_data);
      } else {
        dbGameId = game_id;
        const game = await db('games').where({ id: dbGameId }).first();
        if (!game) return res.status(404).json({ error: 'Game not found' });
      }

      const existing = await db('custom_list_games')
        .where({ list_id: list.id, game_id: dbGameId })
        .first();
      if (existing) return res.status(400).json({ error: 'Game already in this list' });

      const maxPos = await db('custom_list_games')
        .where({ list_id: list.id })
        .max('position as maxPos')
        .first();
      const position = (maxPos.maxPos || 0) + 1;

      await db('custom_list_games').insert({
        list_id:  list.id,
        game_id:  dbGameId,
        user_id:  req.userId,
        note:     note   ? note.trim() : null,
        position,
        status:   status || null,
        score:    score  || null
      });

      res.status(201).json({ message: 'Game added to list', game_id: dbGameId });
    } catch (error) {
      console.error('Add game to list error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.put('/lists/:listId/games/:gameId', verifyToken, checkBanned, async (req, res) => {
    try {
      const list = await db('custom_lists')
        .where({ id: req.params.listId, user_id: req.userId })
        .first();
      if (!list) return res.status(404).json({ error: 'List not found' });

      const { note, status, score } = req.body;

      if (score !== undefined && score !== null && (score < 1 || score > 10)) {
        return res.status(400).json({ error: 'Score must be between 1 and 10' });
      }

      const validStatuses = ['playing', 'completed', 'plan_to_play', 'on_hold', 'dropped'];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
      }

      const updateData = {};
      if (note   !== undefined) updateData.note   = note   ? note.trim() : null;
      if (status !== undefined) updateData.status = status || null;
      if (score  !== undefined) updateData.score  = score  || null;

      const updated = await db('custom_list_games')
        .where({ list_id: list.id, game_id: req.params.gameId })
        .update(updateData);

      if (!updated) return res.status(404).json({ error: 'Game not found in this list' });
      res.json({ message: 'Updated successfully' });
    } catch (error) {
      console.error('Update game in list error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.delete('/lists/:listId/games/:gameId', verifyToken, checkBanned, async (req, res) => {
    try {
      const list = await db('custom_lists')
        .where({ id: req.params.listId, user_id: req.userId })
        .first();
      if (!list) return res.status(404).json({ error: 'List not found' });

      const deleted = await db('custom_list_games')
        .where({ list_id: list.id, game_id: req.params.gameId })
        .del();
      if (!deleted) return res.status(404).json({ error: 'Game not found in this list' });
      res.json({ message: 'Game removed from list' });
    } catch (error) {
      console.error('Remove game from list error:', error);
      return clientError(res, 500, 'Server error', error);
    }
  });

  router.get('/export', verifyToken, checkBanned, async (req, res) => {
    try {
      const user = await db('users').where({ id: req.userId }).first();
      const collection = await db('user_game_lists as ugl')
        .join('games', 'ugl.game_id', 'games.id')
        .where('ugl.user_id', req.userId)
        .select(
          'games.game_id',
          'games.igdb_id',
          'games.tmdb_id',
          'games.media_type',
          'games.name',
          'ugl.status',
          'ugl.score',
          'ugl.notes',
          'ugl.created_at',
          'ugl.updated_at'
        )
        .orderBy('ugl.created_at', 'desc');

      const lists = await db('custom_lists')
        .where({ user_id: req.userId })
        .orderBy('created_at', 'desc');

      const listIds = lists.map(l => l.id);
      const listGames = listIds.length
        ? await db('custom_list_games as clg')
            .join('games', 'clg.game_id', 'games.id')
            .whereIn('clg.list_id', listIds)
            .select(
              'clg.list_id',
              'games.game_id',
              'games.igdb_id',
              'games.tmdb_id',
              'games.media_type',
              'games.name',
              'clg.status',
              'clg.score',
              'clg.note',
              'clg.added_at'
            )
        : [];

      const gamesByList = {};
      listGames.forEach(row => {
        if (!gamesByList[row.list_id]) gamesByList[row.list_id] = [];
        gamesByList[row.list_id].push({
          game_id: row.game_id,
          igdb_id: row.igdb_id,
          tmdb_id: row.tmdb_id,
          media_type: row.media_type || 'game',
          name: row.name,
          status: row.status,
          score: row.score,
          note: row.note,
          added_at: row.added_at
        });
      });

      res.setHeader('Content-Disposition', 'attachment; filename="medialistory-export.json"');
      res.json({
        exported_at: new Date().toISOString(),
        product: 'MediaListory',
        catalog_apis: ['igdb', 'tmdb'],
        user: user
          ? {
              id: user.id,
              username: user.username,
              display_name: user.display_name,
              email: user.email
            }
          : { id: req.userId },
        collection,
        custom_lists: lists.map(list => ({
          id: list.id,
          name: list.name,
          slug: list.slug,
          description: list.description,
          is_public: list.is_public,
          created_at: list.created_at,
          games: gamesByList[list.id] || []
        }))
      });
    } catch (error) {
      console.error('Export error:', error);
      return clientError(res, 500, 'Failed to export data', error);
    }
  });

  return router;
};
