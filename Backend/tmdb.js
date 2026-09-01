const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { createTtlCache } = require('./cache');
const { sanitizeToken, clampInt } = require('./igdbUtils');
const {
  tmdbEndpointFor,
  normalizeTmdb,
  mediaToRow
} = require('./tmdbUtils');

const TMDB_BASE = 'https://api.themoviedb.org/3';

const ALLOWED_SORT = {
  release: 'primary_release_date',
  rating: 'vote_average',
  name: 'original_title',
  popularity: 'popularity',
  coming: 'primary_release_date'
};

// TV uses first_air_date instead of primary_release_date.
function sortFieldFor(mediaType, sortKey) {
  const base = ALLOWED_SORT[sortKey] || ALLOWED_SORT.release;
  if (mediaType === 'series') {
    if (base === 'primary_release_date') return 'first_air_date';
    if (base === 'original_title') return 'name';
  }
  return base;
}

const TTL = {
  genres: 24 * 60 * 60 * 1000,
  list: 3 * 60 * 1000,
  detail: 30 * 60 * 1000
};

module.exports = (verifyToken, checkBanned, db) => {
  const router = express.Router();
  const cache = createTtlCache();

  let lastAPICall = 0;
  const MIN_API_DELAY = 120;

  async function respectRateLimit() {
    const now = Date.now();
    const delta = now - lastAPICall;
    if (delta < MIN_API_DELAY) {
      await new Promise((resolve) => setTimeout(resolve, MIN_API_DELAY - delta));
    }
    lastAPICall = Date.now();
  }

  function getBearer() {
    return (process.env.TMDB_ACCESS_TOKEN || '').trim();
  }
  function getApiKey() {
    return (process.env.TMDB_API_KEY || '').trim();
  }
  function isConfigured() {
    return !!(getBearer() || getApiKey());
  }

  async function tmdbFetch(pathPart, params) {
    if (!isConfigured()) {
      const err = new Error('TMDB credentials not configured');
      err.status = 500;
      err.payload = { error: 'Movie/series data service unavailable' };
      if (process.env.NODE_ENV !== 'production') {
        err.payload.message = 'Set TMDB_ACCESS_TOKEN (v4) or TMDB_API_KEY (v3) in .env';
      }
      throw err;
    }

    const search = new URLSearchParams(params || {});
    const bearer = getBearer();
    const headers = { Accept: 'application/json' };
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    } else {
      search.set('api_key', getApiKey());
    }

    await respectRateLimit();
    const url = `${TMDB_BASE}${pathPart}?${search.toString()}`;
    return fetch(url, { method: 'GET', headers });
  }

  function sendError(res, error, fallbackMessage) {
    if (error.payload) {
      return res.status(error.status || 500).json(error.payload);
    }
    console.error(fallbackMessage, error.message);
    const body = { error: fallbackMessage };
    if (process.env.NODE_ENV !== 'production') body.message = error.message;
    return res.status(500).json(body);
  }

  // ---- genre maps (id<->name), cached per media type -------------------------
  async function getGenreMaps(mediaType) {
    const cacheKey = `genres:${mediaType}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const endpoint = tmdbEndpointFor(mediaType);
    const response = await tmdbFetch(`/genre/${endpoint}/list`, { language: 'en-US' });
    const data = await response.json();
    if (!response.ok) {
      const err = new Error('TMDB genre error');
      err.status = response.status;
      throw err;
    }
    const list = Array.isArray(data.genres) ? data.genres : [];
    const byId = {};
    const byName = {};
    list.forEach((g) => {
      if (!g || g.id == null || !g.name) return;
      byId[g.id] = g.name;
      byName[g.name.toLowerCase()] = g.id;
    });
    const maps = { list, byId, byName };
    cache.set(cacheKey, maps, TTL.genres);
    return maps;
  }

  function buildDiscoverParams(mediaType, body, genreNameToId) {
    const limit = clampInt(body.limit, 1, 50, 20); // TMDB pages are 20 items.
    const offset = clampInt(body.offset, 0, 5000, 0);
    const page = Math.floor(offset / 20) + 1;

    const sortKey = ALLOWED_SORT[body.sort] ? body.sort : 'release';
    const sortOrder = body.sortOrder === 'asc' ? 'asc' : 'desc';
    const comingSoon = !!body.comingSoon || sortKey === 'coming';

    const params = {
      include_adult: 'false',
      language: 'en-US',
      page: String(page)
    };

    const dateField = mediaType === 'series' ? 'first_air_date' : 'primary_release_date';
    const today = new Date().toISOString().slice(0, 10);

    if (comingSoon) {
      params.sort_by = `${dateField}.asc`;
      params[`${dateField}.gte`] = today;
    } else {
      let field = sortFieldFor(mediaType, sortKey);
      let order = sortOrder;
      if (sortKey === 'popularity') { field = 'popularity'; order = 'desc'; }
      params.sort_by = `${field}.${order}`;
      params[`${dateField}.lte`] = today;
      if (sortKey === 'popularity') params['vote_count.gte'] = '50';
    }

    const genre = sanitizeToken(body.genre, 60);
    if (genre && genreNameToId) {
      const id = genreNameToId[genre.toLowerCase()];
      if (id) params.with_genres = String(id);
    }

    return { params, limit };
  }

  async function loadListFromDb(mediaType, body) {
    if (!db) return null;
    try {
      const limit = clampInt(body.limit, 1, 50, 20);
      const offset = clampInt(body.offset, 0, 5000, 0);
      const search = sanitizeToken(body.search, 80);

      let q = db('games').where({ media_type: mediaType }).whereNotNull('tmdb_id').select('*');
      if (search) q = q.where('name', 'ilike', `%${search}%`);

      const sortKey = ALLOWED_SORT[body.sort] ? body.sort : 'release';
      if (sortKey === 'name') q = q.orderBy('name', 'asc');
      else if (sortKey === 'rating' || sortKey === 'popularity') q = q.orderBy('metacritic_score', 'desc');
      else q = q.orderBy('released', 'desc');

      const rows = await q.limit(limit).offset(offset);
      if (!rows.length) return null;
      return rows.map(dbRowToNormalized).filter(Boolean);
    } catch (_) {
      return null;
    }
  }

  function dbRowToNormalized(row) {
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v || '[]') : v || []);
    return {
      id: row.game_id,
      media_type: row.media_type,
      tmdb_id: row.tmdb_id,
      name: row.name,
      background_image: row.background_image || null,
      backdrop_image: row.background_image || null,
      description: row.description || '',
      released: row.released ? new Date(row.released).toISOString().slice(0, 10) : null,
      rating: row.rating != null ? Number(row.rating) : null,
      metacritic_score: row.metacritic_score != null ? Number(row.metacritic_score) : null,
      genres: parse(row.genres),
      developers: parse(row.developers),
      publishers: parse(row.publishers)
    };
  }

  async function loadDetailFromDb(mediaType, tmdbId) {
    if (!db) return null;
    try {
      const row = await db('games').where({ media_type: mediaType, tmdb_id: tmdbId }).first();
      if (!row || !row.name) return null;
      return [dbRowToNormalized(row)];
    } catch (_) {
      return null;
    }
  }

  async function persistMedia(items) {
    if (!db || !Array.isArray(items) || !items.length) return;
    for (const media of items) {
      const row = mediaToRow(media);
      if (!row) continue;
      try {
        await db('games')
          .insert(row)
          .onConflict('game_id')
          .merge({
            name: row.name,
            description: row.description,
            background_image: row.background_image,
            rating: row.rating,
            metacritic_score: row.metacritic_score,
            released: row.released,
            genres: row.genres,
            platforms: row.platforms,
            publishers: row.publishers,
            developers: row.developers,
            tmdb_id: row.tmdb_id,
            media_type: row.media_type
          });
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('TMDB write-through skipped:', err.message);
        }
      }
    }
  }

  async function serveDegradedList(res, mediaType, body, cacheKey) {
    const local = await loadListFromDb(mediaType, body);
    if (local && local.length) {
      cache.set(cacheKey, local, TTL.list);
      res.setHeader('X-Cache', 'DEGRADED');
      res.setHeader('X-Degraded', 'tmdb');
      res.json(local);
      return true;
    }
    return false;
  }

  async function handleMediaRequest(mediaType, req, res) {
    if (req.body && typeof req.body.query === 'string') {
      return res.status(400).json({
        error: 'Raw TMDB queries are not allowed',
        message: 'Send structured filters (id, search, genre, sort, limit, offset).'
      });
    }

    const body = req.body || {};
    const detailId = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0);
    const cacheKey = detailId
      ? `detail:${mediaType}:${detailId}`
      : `list:${mediaType}:${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    const endpoint = tmdbEndpointFor(mediaType);

    try {
      if (detailId) {
        const fromDb = await loadDetailFromDb(mediaType, detailId);
        if (fromDb) {
          cache.set(cacheKey, fromDb, TTL.detail);
          res.setHeader('X-Cache', 'DB');
          return res.json(fromDb);
        }

        const response = await tmdbFetch(`/${endpoint}/${detailId}`, {
          language: 'en-US',
          append_to_response: 'credits'
        });
        const data = await response.json();
        if (!response.ok) {
          return res.status(response.status).json({ error: 'TMDB API error' });
        }
        const normalized = normalizeTmdb(mediaType, data);
        const payload = normalized ? [normalized] : [];
        cache.set(cacheKey, payload, TTL.detail);
        persistMedia(payload).catch(() => {});
        res.setHeader('X-Cache', 'MISS');
        return res.json(payload);
      }

      // list / search
      const maps = await getGenreMaps(mediaType).catch(() => ({ byId: {}, byName: {} }));
      const search = sanitizeToken(body.search, 80);

      let response;
      let limit;
      if (search) {
        const offset = clampInt(body.offset, 0, 5000, 0);
        const page = Math.floor(offset / 20) + 1;
        limit = clampInt(body.limit, 1, 50, 20);
        response = await tmdbFetch(`/search/${endpoint}`, {
          query: search,
          include_adult: 'false',
          language: 'en-US',
          page: String(page)
        });
      } else {
        const built = buildDiscoverParams(mediaType, body, maps.byName);
        limit = built.limit;
        response = await tmdbFetch(`/discover/${endpoint}`, built.params);
      }

      const data = await response.json();
      if (!response.ok) {
        const degraded = await serveDegradedList(res, mediaType, body, cacheKey);
        if (degraded) return;
        return res.status(response.status).json({ error: 'TMDB API error' });
      }

      const results = Array.isArray(data.results) ? data.results : [];
      const normalized = results
        .map((item) => normalizeTmdb(mediaType, item, maps.byId))
        .filter(Boolean)
        .slice(0, limit);

      cache.set(cacheKey, normalized, TTL.list);
      persistMedia(normalized).catch(() => {});
      res.setHeader('X-Cache', 'MISS');
      return res.json(normalized);
    } catch (error) {
      if (!detailId) {
        const degraded = await serveDegradedList(res, mediaType, body, cacheKey);
        if (degraded) return;
      }
      return sendError(res, error, 'Failed to fetch from TMDB');
    }
  }

  router.use(verifyToken, checkBanned);

  router.post('/movies', (req, res) => handleMediaRequest('movie', req, res));
  router.post('/series', (req, res) => handleMediaRequest('series', req, res));

  router.post('/genres', async (req, res) => {
    try {
      const mediaType = (req.body && req.body.media_type) === 'series' ? 'series' : 'movie';
      const maps = await getGenreMaps(mediaType);
      res.setHeader('X-Cache', cache.get(`genres:${mediaType}`) ? 'HIT' : 'MISS');
      res.json(maps.list);
    } catch (error) {
      sendError(res, error, 'Failed to fetch genres from TMDB');
    }
  });

  return router;
};
