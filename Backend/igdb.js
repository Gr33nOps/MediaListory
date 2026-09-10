const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { createTtlCache } = require('./cache');
const {
  sanitizeToken,
  clampInt,
  rankSearchResults,
  mapIgdbToRow
} = require('./igdbUtils');
const { buildRelations, hasRelations } = require('./relations');

const GAME_FIELDS =
  'name, cover.url, rating, rating_count, summary, first_release_date, ' +
  'aggregated_rating, aggregated_rating_count, total_rating, total_rating_count, ' +
  'genres.name, platforms.name, involved_companies.company.name, ' +
  'involved_companies.publisher, involved_companies.developer';

const DETAIL_FIELDS =
  GAME_FIELDS + ', storyline, screenshots.url, videos.video_id, videos.name, ' +
  'game_modes.name, player_perspectives.name, ' +
  'similar_games.name, similar_games.cover.url, similar_games.total_rating, ' +
  // The series this game belongs to. IGDB calls it a collection and will expand
  // its members inline, so the whole run costs nothing beyond the detail call.
  'collections.name, collections.games.name, collections.games.cover.url, ' +
  'collections.games.first_release_date, collections.games.game_type';

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

  /* The other games in this one's series.

     IGDB has no prequel/sequel edge, only membership of a collection, so the
     entries are ordered by release date and labelled earlier/later - which is
     all we actually know. Ports, bundles and expansions are left out: they are
     the same game again, not the one before or after it. */
  /* Main games and standalone expansions only. Remakes, remasters, ports and
     enhanced editions are the same game again - listing them as "earlier" would
     put four versions of The Witcher between it and its sequel. */
  const SERIES_GAME_TYPES = new Set([0, 4]);

  function seriesRelations(game) {
    const collections = Array.isArray(game && game.collections) ? game.collections : [];
    const entries = [];
    for (const collection of collections) {
      for (const member of (collection.games || [])) {
        if (!member || !member.name) continue;
        if (member.game_type != null && !SERIES_GAME_TYPES.has(Number(member.game_type))) continue;
        entries.push({
          id: member.id,
          name: member.name,
          released: member.first_release_date
            ? new Date(member.first_release_date * 1000).toISOString().slice(0, 10)
            : null,
          image: member.cover && member.cover.url
            ? 'https:' + String(member.cover.url).replace('t_thumb', 't_cover_small')
            : null
        });
      }
    }
    return buildRelations(entries, game.id);
  }

  function buildGamesQuery(body, opts = {}) {
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
    const gameMode = sanitizeToken(body.gameMode, 60);
    const year = clampInt(body.year, 1958, new Date().getFullYear() + 10, 0);
    const minRating = clampInt(body.minRating, 1, 100, 0);
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
      // `hypes` is IGDB's anticipation count. Requiring it keeps the upcoming
      // list to games people are actually waiting for.
      where.push(`first_release_date > ${now}`);
      if (!search) where.push('hypes != null');
    } else if (trending && !search) {
      // "Trending": recently-released titles that already have real traction.
      where.push(`first_release_date != null & first_release_date >= ${now - TRENDING_WINDOW} & first_release_date <= ${now}`);
      where.push('total_rating_count != null & total_rating_count >= 3');
    } else if (year) {
      // Explicit year bounds the release window to that calendar year (UTC).
      const start = Math.floor(Date.UTC(year, 0, 1) / 1000);
      const end = Math.floor(Date.UTC(year + 1, 0, 1) / 1000) - 1;
      where.push(`first_release_date >= ${start} & first_release_date <= ${end}`);
      if (sortKey === 'popularity' && !search) {
        where.push('total_rating_count != null & total_rating_count >= 5');
      }
    } else {
      where.push(`first_release_date != null & first_release_date <= ${now}`);
      if (sortKey === 'popularity' && !search) {
        where.push('total_rating_count != null & total_rating_count >= 5');
      }
      // "Newest" otherwise fills up with same-day shovelware nobody has touched.
      if (sortKey === 'release' && sortOrder === 'desc' && !search) {
        where.push('total_rating_count != null');
      }
    }

    // When the user has already narrowed things down these floors relax, so a
    // specific genre/platform/year combination still returns a full page.
    const narrowed = !!(genre || platform || gameMode || year || minRating);
    // total_rating blends player and critic scores, so a game carrying a single
    // 100/100 critic review is pushed to the very top (Super Metroid and Super
    // Mario World were outranking Elden Ring on one review each). Require both a
    // real player base and real critic coverage behind the score.
    if (sortKey === 'rating') {
      where.push(`total_rating_count != null & total_rating_count >= ${narrowed ? 50 : 200}`);
      where.push(`aggregated_rating_count != null & aggregated_rating_count >= ${narrowed ? 2 : 5}`);
    }
    // Alphabetical sorts otherwise open on symbol-only joke titles ("^_^", "_____").
    if (sortKey === 'name' && !search) {
      where.push(`total_rating_count != null & total_rating_count >= ${narrowed ? 5 : 20}`);
    }

    // Text search: prefer IGDB's native `search` (handles multi-word titles,
    // punctuation and relevance far better than a raw substring match). The
    // substring fallback (opts.mode === 'substring') is an order-independent,
    // punctuation-tolerant token match used only when native search finds nothing.
    const useNativeSearch = !!search && opts.mode !== 'substring';
    if (search && !useNativeSearch) {
      const tokens = search.split(/\s+/).filter((t) => t.length >= 2).slice(0, 6);
      where.push(tokens.length
        ? '(' + tokens.map((t) => `name ~ *"${t}"*`).join(' & ') + ')'
        : `name ~ *"${search}"*`);
    }
    if (genre) where.push(`genres.name = "${genre}"`);
    if (platform) where.push(`platforms.name = "${platform}"`);
    if (gameMode) where.push(`game_modes.name = "${gameMode}"`);
    if (minRating) where.push(`total_rating >= ${minRating}`);
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
      finalSortField = 'hypes';
      finalSortOrder = 'desc';
    } else if (trending || sortKey === 'popularity') {
      finalSortField = 'total_rating_count';
      finalSortOrder = 'desc';
    }

    const parts = [`fields ${GAME_FIELDS};`];
    // Native search carries its own relevance order and rejects an explicit
    // `sort` (IGDB returns 406), so the sort clause is omitted in that mode.
    if (useNativeSearch) parts.push(`search "${search}";`);
    parts.push(`limit ${limit};`, `offset ${offset};`, `where ${where.join(' & ')};`);
    if (!useNativeSearch) parts.push(`sort ${finalSortField} ${finalSortOrder};`);
    return parts.join(' ');
  }

  // IGDB's games table carries no usable popularity column (`follows` is empty
  // for every row), so ordering by total_rating_count really means "most rated"
  // and skews to old titles. Real popularity lives in the popularity_primitives
  // feed; type 3 is "Playing". That feed cannot be combined with where filters,
  // so it backs only the plain unfiltered Popularity browse and falls back to
  // the previous ordering whenever it is unavailable.
  const POPULARITY_TYPE_PLAYING = 3;
  async function fetchPopularGames(body) {
    const limit = clampInt(body.limit, 1, 50, 20);
    const offset = clampInt(body.offset, 0, 5000, 0);
    // Over-fetch 2x: some ids are DLC, editions or coverless and get dropped
    // below. Stepping the primitive offset by the same factor keeps pages from
    // overlapping, so no game can show up on two pages.
    const primResp = await igdbFetch(
      '/popularity_primitives',
      `fields game_id; where popularity_type = ${POPULARITY_TYPE_PLAYING}; sort value desc; limit ${limit * 2}; offset ${offset * 2};`
    );
    if (!primResp.ok) return null;
    const prims = await primResp.json();
    const ids = (Array.isArray(prims) ? prims : []).map((p) => p && p.game_id).filter(Boolean);
    if (!ids.length) return null;

    const gamesResp = await igdbFetch(
      '/games',
      `fields ${GAME_FIELDS}; where id = (${ids.join(',')}) & version_parent = null & parent_game = null & game_type = (0,4,8,9,10,11) & cover != null; limit ${ids.length};`
    );
    if (!gamesResp.ok) return null;
    const games = await gamesResp.json();
    if (!Array.isArray(games) || !games.length) return null;

    // Restore the order the popularity feed returned them in.
    const rank = {};
    ids.forEach((id, i) => { rank[id] = i; });
    games.sort((a, b) => (rank[a.id] == null ? 1e9 : rank[a.id]) - (rank[b.id] == null ? 1e9 : rank[b.id]));
    return games.slice(0, limit);
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

      /* IGDB's native search carries its own relevance order and returns 406
         if a sort is sent with it, so searching means the sort is dropped.
         Filters are where-clauses and do still combine.

         Set before the cache is consulted: it depends only on the request, and
         setting it after would show the notice once and never again. */
      if (!detailId) {
        // No sort works during a search here either: IGDB rejects the clause.
        res.setHeader('X-Sort-State', sanitizeToken(body.search, 80) ? 'unavailable' : 'applied');
        res.setHeader('X-Filters-Applied', '1');
      }

      const cached = cache.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }

      // Detail views must come from IGDB so they carry the rich fields (videos,
      // screenshots, similar games, modes). The stored DB row only has the
      // browse-level columns, so it is a fallback for when IGDB is unavailable,
      // not the primary source.
      const searchTerm = detailId ? '' : sanitizeToken(body.search, 80);

      // Plain "Popularity" browse (no search, no filters) uses the real
      // popularity feed. Anything narrower keeps the where-clause path so the
      // filters, sorting and pagination all still apply server-side.
      const plainPopular = !detailId && !searchTerm && body.sort === 'popularity' &&
        !body.comingSoon && !body.trending && !body.genre && !body.platform &&
        !body.gameMode && !body.year && !body.minRating && !body.publisher && !body.developer;
      if (plainPopular) {
        const popular = await fetchPopularGames(body).catch(() => null);
        if (popular && popular.length) {
          cache.set(cacheKey, popular, TTL.list);
          persistGames(popular).catch(() => {});
          res.setHeader('X-Cache', 'MISS');
          return res.json(popular);
        }
        // Feed unavailable: fall through to the rating-count ordering below.
      }

      let response = await igdbFetch('/games', buildGamesQuery(body));
      let data = await response.json();

      // Native search found nothing - retry once with the punctuation-tolerant
      // substring token fallback before giving up (still full-catalog, filtered).
      if (response.ok && searchTerm && Array.isArray(data) && data.length === 0) {
        const fbResp = await igdbFetch('/games', buildGamesQuery(body, { mode: 'substring' }));
        const fbData = await fbResp.json();
        if (fbResp.ok && Array.isArray(fbData) && fbData.length) { response = fbResp; data = fbData; }
      }

      if (!response.ok) {
        if (detailId) {
          const fromDb = await loadDetailFromDb(detailId);
          if (fromDb) {
            cache.set(cacheKey, fromDb, TTL.detail);
            res.setHeader('X-Cache', 'DB');
            res.setHeader('X-Degraded', 'igdb');
            return res.json(fromDb);
          }
        } else {
          const degraded = await serveDegradedList(res, body, cacheKey);
          if (degraded) return;
        }
        return res.status(response.status).json({ error: 'IGDB API error' });
      }

      // Promote exact / prefix title matches to the top when searching. This
      // re-orders the fetched results only - it never removes any of them.
      if (searchTerm && Array.isArray(data)) {
        data = rankSearchResults(data, searchTerm, (g) => g && g.name);
      }

      if (detailId && Array.isArray(data) && data[0]) {
        const rel = seriesRelations(data[0]);
        if (hasRelations(rel)) data[0].relations = rel;
        // The expanded collection is only raw material for that strip; sending
        // it on would add kilobytes the client never reads.
        delete data[0].collections;
      }

      cache.set(cacheKey, data, detailId ? TTL.detail : TTL.list);
      // Fire-and-forget write-through
      persistGames(data).catch(() => {});

      res.setHeader('X-Cache', 'MISS');
      res.json(data);
    } catch (error) {
      const detailId = clampInt(req.body && req.body.id, 1, Number.MAX_SAFE_INTEGER, 0);
      if (detailId) {
        const fromDb = await loadDetailFromDb(detailId);
        if (fromDb) {
          res.setHeader('X-Cache', 'DB');
          res.setHeader('X-Degraded', 'igdb');
          return res.json(fromDb);
        }
      } else {
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

  router.post('/game_modes', async (req, res) => {
    try {
      const cached = cache.get('game_modes');
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached);
      }

      const response = await igdbFetch('/game_modes', 'fields name; limit 50; sort name asc;');
      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({ error: 'IGDB API error' });
      }

      cache.set('game_modes', data, TTL.genres);
      res.setHeader('X-Cache', 'MISS');
      res.json(data);
    } catch (error) {
      sendError(res, error, 'Failed to fetch game modes from IGDB');
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
