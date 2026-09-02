const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { createTtlCache } = require('./cache');
const {
  sanitizeToken,
  clampInt,
  mapIgdbToRow
} = require('./igdbUtils');

const GAME_FIELDS =
  'name, cover.url, rating, rating_count, summary, first_release_date, ' +
  'aggregated_rating, aggregated_rating_count, total_rating, total_rating_count, ' +
  'genres.name, platforms.name, involved_companies.company.name, ' +
  'involved_companies.publisher, involved_companies.developer';

const DETAIL_FIELDS =
  GAME_FIELDS + ', screenshots.url';

const ALLOWED_SORT = {
  release: 'first_release_date',
  rating: 'total_rating',
  name: 'name',
  popularity: 'total_rating_count',
  coming: 'first_release_date'
};

const TTL = {
  genres: 24 * 60 * 60 * 1000,
  platforms: 24 * 60 * 60 * 1000,
  list: 3 * 60 * 1000,
  detail: 30 * 60 * 1000
};

function dbRowToIgdbShape(row) {
  const genres = typeof row.genres === 'string' ? JSON.parse(row.genres || '[]') : (row.genres || []);
  const platforms = typeof row.platforms === 'string' ? JSON.parse(row.platforms || '[]') : (row.platforms || []);
  const publishers = typeof row.publishers === 'string' ? JSON.parse(row.publishers || '[]') : (row.publishers || []);
  const developers = typeof row.developers === 'string' ? JSON.parse(row.developers || '[]') : (row.developers || []);

  const involved = [];
  publishers.forEach(p => {
    if (p?.name) involved.push({ publisher: true, company: { name: p.name } });
  });
  developers.forEach(d => {
    if (d?.name) involved.push({ developer: true, company: { name: d.name } });
  });

  let cover = null;
  if (row.background_image) {
    // Frontend expects protocol-relative IGDB-style cover URLs when transforming.
    const url = row.background_image.replace(/^https?:/, '');
    cover = { url: url.includes('t_') ? url.replace(/t_[a-z0-9_]+/, 't_thumb') : url };
  }

  const firstRelease = row.released
    ? Math.floor(new Date(row.released).getTime() / 1000)
    : null;

  return {
    id: row.igdb_id,
    name: row.name,
    summary: row.description || '',
    cover,
    first_release_date: firstRelease,
    total_rating: row.metacritic_score || null,
    total_rating_count: row.metacritic_score ? 10 : 0,
    aggregated_rating: row.metacritic_score || null,
    aggregated_rating_count: row.metacritic_score ? 5 : 0,
    rating: row.rating ? Number(row.rating) * 20 : null,
    rating_count: 0,
    genres,
    platforms,
    involved_companies: involved
  };
}

module.exports = (verifyToken, checkBanned, db) => {
  const router = express.Router();
  const cache = createTtlCache();

  let cachedToken = (process.env.IGDB_ACCESS_TOKEN || '').trim();
  let tokenExpiresAt = cachedToken ? Date.now() + 6 * 60 * 60 * 1000 : 0;

  let lastAPICall = 0;
  const MIN_API_DELAY = 250;

  async function respectRateLimit() {
    const now = Date.now();
    const timeSinceLastCall = now - lastAPICall;
    if (timeSinceLastCall < MIN_API_DELAY) {
      await new Promise(resolve => setTimeout(resolve, MIN_API_DELAY - timeSinceLastCall));
    }
    lastAPICall = Date.now();
  }

  function getClientId() {
    return (process.env.IGDB_CLIENT_ID || '').trim();
  }

  async function getAccessToken() {
    const clientId = getClientId();
    const clientSecret = (process.env.IGDB_CLIENT_SECRET || '').trim();
    const now = Date.now();

    if (cachedToken && now < tokenExpiresAt - 60_000) {
      return cachedToken;
    }

    if (clientId && clientSecret) {
      const url =
        'https://id.twitch.tv/oauth2/token' +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&client_secret=${encodeURIComponent(clientSecret)}` +
        '&grant_type=client_credentials';

      const tokenRes = await fetch(url, { method: 'POST' });
      const tokenData = await tokenRes.json();

      if (!tokenRes.ok || !tokenData.access_token) {
        const err = new Error('Failed to refresh Twitch/IGDB access token');
        err.details = tokenData;
        throw err;
      }

      cachedToken = tokenData.access_token;
      tokenExpiresAt = now + (Number(tokenData.expires_in) || 5000) * 1000;
      process.env.IGDB_ACCESS_TOKEN = cachedToken;
      return cachedToken;
    }

    if (cachedToken) return cachedToken;
    return '';
  }

  async function igdbFetch(path, body) {
    const clientId = getClientId();
    const accessToken = await getAccessToken();

    if (!clientId || !accessToken) {
      const err = new Error('IGDB credentials not configured');
      err.status = 500;
      err.payload = { error: 'Game data service unavailable' };
      if (process.env.NODE_ENV !== 'production') {
        err.payload.message = 'Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET (or IGDB_ACCESS_TOKEN) in .env';
      }
      throw err;
    }

    await respectRateLimit();

    return fetch(`https://api.igdb.com/v4${path}`, {
      method: 'POST',
      headers: {
        'Client-ID': clientId,
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      },
      body
    });
  }

  function sendError(res, error, fallbackMessage) {
    if (error.payload) {
      return res.status(error.status || 500).json(error.payload);
    }
    console.error(fallbackMessage, error.message);
    const body = { error: fallbackMessage };
    if (process.env.NODE_ENV !== 'production') {
      body.message = error.message;
    }
    return res.status(500).json(body);
  }

  function buildGamesQuery(body) {
    const id = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0);
    if (id) {
      return `fields ${DETAIL_FIELDS}; where id = ${id};`;
    }

    const limit = clampInt(body.limit, 1, 50, 20);
    const offset = clampInt(body.offset, 0, 5000, 0);
    const search = sanitizeToken(body.search, 80);
    const genre = sanitizeToken(body.genre, 60);
    const platform = sanitizeToken(body.platform, 60);
    const publisher = sanitizeToken(body.publisher, 80);
    const developer = sanitizeToken(body.developer, 80);
    const sortKey = ALLOWED_SORT[body.sort] ? body.sort : 'release';
    const sortField = ALLOWED_SORT[sortKey];
    const sortOrder = body.sortOrder === 'asc' ? 'asc' : 'desc';
    const comingSoon = !!body.comingSoon;
    const trending = !!body.trending && !comingSoon;
    const now = Math.floor(Date.now() / 1000);
    const TRENDING_WINDOW = 60 * 60 * 24 * 540; // ~18 months of recent releases

    // Main games + remakes/remasters/etc. Exclude DLC/mods/episodes via game_type.
    // version_parent / parent_game null drops editions that are child versions.
    const where = [
      'version_parent = null',
      'parent_game = null',
      'game_type = (0,4,8,9,10,11)'
    ];

    if (!search) where.push('cover != null');

    if (comingSoon || sortKey === 'coming') {
      where.push(`first_release_date > ${now}`);
    } else if (trending && !search) {
      // "Trending": recently-released titles that already have real traction.
      where.push(`first_release_date != null & first_release_date >= ${now - TRENDING_WINDOW} & first_release_date <= ${now}`);
      where.push('total_rating_count != null & total_rating_count >= 3');
    } else {
      where.push(`first_release_date != null & first_release_date <= ${now}`);
      if (sortKey === 'popularity' && !search) {
        where.push('total_rating_count != null & total_rating_count >= 5');
      }
    }

    if (search) where.push(`name ~ *"${search}"*`);
    if (genre) where.push(`genres.name = "${genre}"`);
    if (platform) where.push(`platforms.name = "${platform}"`);
    if (publisher) {
      where.push(
        `involved_companies.company.name = "${publisher}" & involved_companies.publisher = true`
      );
    }
    if (developer) {
      where.push(
        `involved_companies.company.name = "${developer}" & involved_companies.developer = true`
      );
    }

    let finalSortField = sortField;
    let finalSortOrder = sortOrder;
    if (comingSoon || sortKey === 'coming') {
      finalSortField = 'first_release_date';
      finalSortOrder = 'asc';
    } else if (trending || sortKey === 'popularity') {
      finalSortField = 'total_rating_count';
      finalSortOrder = 'desc';
    }

    return [
      `fields ${GAME_FIELDS};`,
      `limit ${limit};`,
      `offset ${offset};`,
      `where ${where.join(' & ')};`,
      `sort ${finalSortField} ${finalSortOrder};`
    ].join(' ');
  }

  async function persistGames(games) {
    if (!db || !Array.isArray(games) || games.length === 0) return;
    for (const game of games) {
      if (!game?.id || !game?.name) continue;
      const row = mapIgdbToRow(game);
      try {
        await db('games')
          .insert(row)
          .onConflict('igdb_id')
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
            game_id: row.game_id,
            media_type: row.media_type,
            provider: row.provider,
            provider_id: row.provider_id
          });
      } catch (err) {
        // Ignore schema/constraint issues so browse never fails on cache write.
        if (process.env.NODE_ENV !== 'production') {
          console.warn('IGDB write-through skipped:', err.message);
        }
      }
    }
  }

  async function loadDetailFromDb(igdbId) {
    if (!db) return null;
    try {
      const row = await db('games').where({ igdb_id: igdbId }).first();
      if (!row || !row.name) return null;
      return [dbRowToIgdbShape(row)];
    } catch (_) {
      return null;
    }
  }

  async function loadListFromDb(body) {
    if (!db) return null;
    try {
      const limit = clampInt(body.limit, 1, 50, 20);
      const offset = clampInt(body.offset, 0, 5000, 0);
      const search = sanitizeToken(body.search, 80);

      let q = db('games')
        .whereNotNull('igdb_id')
        .select('*');

      if (search) {
        q = q.where('name', 'ilike', `%${search}%`);
      }

      const sortKey = ALLOWED_SORT[body.sort] ? body.sort : 'release';
      if (sortKey === 'name') {
        q = q.orderBy('name', 'asc');
      } else if (sortKey === 'rating' || sortKey === 'popularity') {
        q = q.orderBy('metacritic_score', 'desc');
      } else {
        q = q.orderBy('released', 'desc');
      }

      const rows = await q.limit(limit).offset(offset);
      if (!rows.length) return null;
      return rows.map(dbRowToIgdbShape).filter((g) => g && g.id);
    } catch (_) {
      return null;
    }
  }

  async function serveDegradedList(res, body, cacheKey) {
    const local = await loadListFromDb(body);
    if (local && local.length) {
      cache.set(cacheKey, local, TTL.list);
      res.setHeader('X-Cache', 'DEGRADED');
      res.setHeader('X-Degraded', 'igdb');
      return res.json(local);
    }
    return null;
  }

  router.use(verifyToken, checkBanned);

  router.post('/games', async (req, res) => {
    try {
      if (req.body && typeof req.body.query === 'string') {
        return res.status(400).json({
          error: 'Raw IGDB queries are not allowed',
          message: 'Send structured filters (id, search, genre, platform, sort, limit, offset).'
        });
      }

      const body = req.body || {};
      const detailId = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0);
      const cacheKey = detailId
        ? `detail:${detailId}`
        : `list:${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}`;

      const cached = cache.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }

      if (detailId) {
        const fromDb = await loadDetailFromDb(detailId);
        if (fromDb) {
          cache.set(cacheKey, fromDb, TTL.detail);
          res.setHeader('X-Cache', 'DB');
          return res.json(fromDb);
        }
      }

      const query = buildGamesQuery(body);
      const response = await igdbFetch('/games', query);
      const data = await response.json();

      if (!response.ok) {
        if (!detailId) {
          const degraded = await serveDegradedList(res, body, cacheKey);
          if (degraded) return;
        }
        return res.status(response.status).json({ error: 'IGDB API error' });
      }

      cache.set(cacheKey, data, detailId ? TTL.detail : TTL.list);
      // Fire-and-forget write-through
      persistGames(data).catch(() => {});

      res.setHeader('X-Cache', 'MISS');
      res.json(data);
    } catch (error) {
      if (!(req.body && clampInt(req.body.id, 1, Number.MAX_SAFE_INTEGER, 0))) {
        const body = req.body || {};
        const cacheKey = `list:${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}`;
        const degraded = await serveDegradedList(res, body, cacheKey);
        if (degraded) return;
      }
      sendError(res, error, 'Failed to fetch from IGDB');
    }
  });

  router.post('/genres', async (req, res) => {
    try {
      const cached = cache.get('genres');
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }

      const response = await igdbFetch('/genres', 'fields name; limit 50; sort name asc;');
      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({ error: 'IGDB API error' });
      }

      cache.set('genres', data, TTL.genres);
      res.setHeader('X-Cache', 'MISS');
      res.json(data);
    } catch (error) {
      sendError(res, error, 'Failed to fetch genres from IGDB');
    }
  });

  router.post('/platforms', async (req, res) => {
    try {
      const cached = cache.get('platforms');
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }

      const response = await igdbFetch(
        '/platforms',
        'fields name; where platform_type = (1,5,6); limit 100; sort name asc;'
      );
      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({ error: 'IGDB API error' });
      }

      cache.set('platforms', data, TTL.platforms);
      res.setHeader('X-Cache', 'MISS');
      res.json(data);
    } catch (error) {
      sendError(res, error, 'Failed to fetch platforms from IGDB');
    }
  });

  // Background warm of genres/platforms so browse filters stay available.
  async function warmCatalogCaches() {
    try {
      if (!cache.get('genres')) {
        const response = await igdbFetch('/genres', 'fields name; limit 50; sort name asc;');
        if (response.ok) {
          cache.set('genres', await response.json(), TTL.genres);
        }
      }
      if (!cache.get('platforms')) {
        const response = await igdbFetch(
          '/platforms',
          'fields name; where platform_type = (1,5,6); limit 100; sort name asc;'
        );
        if (response.ok) {
          cache.set('platforms', await response.json(), TTL.platforms);
        }
      }
      // Popular list warm (first page)
      const popularBody = { sort: 'popularity', limit: 20, offset: 0 };
      const popularKey = `list:${crypto.createHash('sha1').update(JSON.stringify(popularBody)).digest('hex')}`;
      if (!cache.get(popularKey)) {
        const query = buildGamesQuery(popularBody);
        const response = await igdbFetch('/games', query);
        if (response.ok) {
          const data = await response.json();
          cache.set(popularKey, data, TTL.list);
          persistGames(data).catch(() => {});
        }
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('Catalog warm skipped:', err.message);
      }
    }
  }

  if (!global.__mglCatalogWarmStarted) {
    global.__mglCatalogWarmStarted = true;
    const warmMs = clampInt(process.env.CATALOG_WARM_MS, 60_000, 24 * 60 * 60 * 1000, 30 * 60 * 1000);
    setTimeout(warmCatalogCaches, 15_000);
    setInterval(warmCatalogCaches, warmMs);
  }

  return router;
};
