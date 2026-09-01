const express = require('express');
const { clientError } = require('./errors');
const { isValidMediaType } = require('./tmdbUtils');

// Metadata lives in JSON columns on `games` (the source of truth for every media
// type). These helpers keep the public response shape stable while reading JSON.
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value || '[]'); } catch (_) { return []; }
  }
  return value || [];
}

// Normalize a stored JSON metadata array into [{ id, name }] for the client.
function toNamed(list) {
  return parseJsonArray(list)
    .map((item) => {
      if (item == null) return null;
      if (typeof item === 'string') return { id: null, name: item };
      return { id: item.id != null ? item.id : null, name: item.name || '' };
    })
    .filter((x) => x && x.name);
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/games', async (req, res) => {
    try {
      const {
        search,
        releaseYear,
        publisher,
        developer,
        platform,
        genre,
        media_type,
        limit = 20,
        offset = 0,
        sort = 'rating',
        order = 'desc'
      } = req.query;

      const applyFilters = (q) => {
        if (search)      q = q.where('games.name', 'ilike', `%${search}%`);
        if (releaseYear) q = q.whereRaw('EXTRACT(YEAR FROM games.released) = ?', [releaseYear]);
        if (publisher)   q = q.whereRaw(`games.publishers::text ILIKE ?`, [`%${publisher}%`]);
        if (developer)   q = q.whereRaw(`games.developers::text ILIKE ?`, [`%${developer}%`]);
        if (platform)    q = q.whereRaw(`games.platforms::text ILIKE ?`, [`%${platform}%`]);
        if (genre)       q = q.whereRaw(`games.genres::text ILIKE ?`, [`%${genre}%`]);
        if (media_type && isValidMediaType(media_type)) q = q.where('games.media_type', media_type);
        return q;
      };

      let query = applyFilters(
        db('games').select(
          'games.id',
          'games.game_id',
          'games.igdb_id',
          'games.tmdb_id',
          'games.media_type',
          'games.name',
          'games.background_image',
          'games.rating',
          'games.description',
          db.raw("TO_CHAR(games.released, 'YYYY') as release_year"),
          'games.released',
          'games.genres',
          'games.platforms',
          'games.publishers',
          'games.developers'
        )
      );

      const sortOrder = order.toLowerCase() === 'asc' ? 'asc' : 'desc';
      switch (sort) {
        case 'name':       query = query.orderBy('games.name', sortOrder); break;
        case 'release':    query = query.orderBy('games.released', sortOrder); break;
        case 'created_at': query = query.orderBy('games.created_at', sortOrder); break;
        case 'id':         query = query.orderBy('games.id', sortOrder); break;
        case 'rating':
        default:
          query = query.orderBy('games.rating', sortOrder);
          if (sortOrder === 'desc') query = query.orderBy('games.name', 'asc');
          break;
      }

      const parsedLimit  = parseInt(limit);
      const parsedOffset = parseInt(offset);
      if (parsedLimit > 0) query = query.limit(parsedLimit).offset(parsedOffset);

      const countQuery = applyFilters(db('games')).count('games.id as total');

      const [games, totalResult] = await Promise.all([query, countQuery.first()]);
      const total = parseInt(totalResult?.total || 0);

      games.forEach((game) => {
        game.media_type = game.media_type || 'game';
        game.genres     = toNamed(game.genres);
        game.platforms  = toNamed(game.platforms);
        game.publishers = toNamed(game.publishers);
        game.developers = toNamed(game.developers);
      });

      res.json({
        games,
        total,
        hasMore: parsedLimit > 0 && (parsedOffset + parsedLimit) < total
      });
    } catch (error) {
      console.error('Games API Error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  router.get('/games/:id', async (req, res) => {
    try {
      const game = await db('games')
        .where({ id: req.params.id })
        .select(
          'id', 'game_id', 'name', 'description', 'background_image',
          'rating', 'metacritic_score', 'playtime', 'igdb_id', 'tmdb_id', 'media_type',
          'genres', 'platforms', 'publishers', 'developers',
          db.raw("TO_CHAR(released, 'YYYY-MM-DD') as released")
        )
        .first();

      if (!game) return res.status(404).json({ error: 'Game not found' });

      game.media_type = game.media_type || 'game';
      game.genres     = toNamed(game.genres);
      game.publishers = toNamed(game.publishers);
      game.developers = toNamed(game.developers);
      game.platforms  = toNamed(game.platforms);

      res.json(game);
    } catch (error) {
      console.error('Game Details API Error:', error);
      return clientError(res, 400, 'Request failed', error);
    }
  });

  return router;
};
