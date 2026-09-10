const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { createTtlCache } = require('./cache');
const { sanitizeToken, clampInt, rankSearchResults } = require('./igdbUtils');
const {
  tmdbEndpointFor,
  normalizeTmdb,
  mediaToRow,
  tmdbImage,
  externalRef
} = require('./tmdbUtils');
const { buildRelations, hasRelations } = require('./relations');

const TMDB_BASE = 'https://api.themoviedb.org/3';

const ALLOWED_SORT = {
  release: 'primary_release_date',
  rating: 'vote_average',
  name: 'title',
  popularity: 'popularity',
  coming: 'primary_release_date'
};

// TV uses first_air_date / name instead of primary_release_date / title.
function sortFieldFor(mediaType, sortKey) {
  const base = ALLOWED_SORT[sortKey] || ALLOWED_SORT.release;
  if (mediaType === 'series') {
    if (base === 'primary_release_date') return 'first_air_date';
    if (base === 'title') return 'name';
  }
  return base;
}

const TTL = {
  genres: 24 * 60 * 60 * 1000,
  list: 3 * 60 * 1000,
  detail: 30 * 60 * 1000
};

// Anime has its own category (Kitsu), so it must never appear under Shows.
// TMDB's "anime" keyword covers it on /discover; /search takes no keyword
// params, so Japanese animation is also screened out by genre + language.
const TMDB_ANIME_KEYWORD = '210024';
const ANIMATION_GENRE_ID = 16;
function isJapaneseAnimation(item) {
  if (!item || item.original_language !== 'ja') return false;
  const ids = Array.isArray(item.genre_ids)
    ? item.genre_ids
    : (Array.isArray(item.genres) ? item.genres.map((g) => g && g.id) : []);
  return ids.indexOf(ANIMATION_GENRE_ID) !== -1;
}

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

  /* The other films in this one's collection.

     Only movies have this: TMDB models a film series as a `collection` and
     hands the id back on the detail response, so it costs one extra call. TV
     has no equivalent - TMDB does not record that one show follows another - so
     shows get no series strip rather than a guessed one. */
  async function collectionRelations(detail, currentRef) {
    const collectionId = detail && detail.belongs_to_collection && detail.belongs_to_collection.id;
    if (!collectionId) return [];

    const res = await tmdbFetch(`/collection/${collectionId}`, { language: 'en-US' });
    if (!res.ok) return [];
    const body = await res.json();

    const entries = (body.parts || []).map((part) => ({
      id: externalRef('movie', part.id),
      name: part.title || part.name,
      released: part.release_date || null,
      image: tmdbImage(part.poster_path, 'w185')
    }));
    return buildRelations(entries, currentRef);
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

    /* TMDB's search endpoint takes a query and nothing else: no sort_by, no
       genre, no year. Discover takes all of them. So searching silently drops
       every filter and the sort, and the client has to be able to say so.

       Set before the cache is consulted, because it depends only on the request
       - set after, it would appear on the first response and never again. */
    if (!detailId) {
      const searching = !!sanitizeToken(body.search, 80);
      // No sort works during a search here, so the control has nothing to offer.
      res.setHeader('X-Sort-State', searching ? 'unavailable' : 'applied');
      res.setHeader('X-Filters-Applied', searching ? '0' : '1');
    }
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

  // Runtime buckets -> with_runtime.gte / .lte (minutes). Server-side on discover.
  const RUNTIME_BUCKETS = {
    short:  { lte: 90 },              // under 1h30
    medium: { gte: 90, lte: 120 },    // 1h30 - 2h
    long:   { gte: 120 }              // over 2h
  };

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

    const isSeries = mediaType === 'series';
    // Shows never include anime; that lives in its own Kitsu-backed category.
    if (isSeries) params.without_keywords = TMDB_ANIME_KEYWORD;
    // When the user has already narrowed things down, the strict quality floors
    // below would often leave an empty page, so they relax. Unfiltered browsing
    // keeps the strict floors that make each sort read well.
    const narrowed = !!(body.genre || body.year || body.language || body.runtime ||
      body.minRating || (isSeries && (body.status != null || body.type != null)));

    if (comingSoon) {
      // Strictly in the future (today's releases are already out), ordered by
      // anticipation rather than date so the list leads with titles people are
      // actually waiting for instead of every obscure same-day release.
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      params.sort_by = 'popularity.desc';
      params[`${dateField}.gte`] = tomorrow;
      if (!isSeries) {
        params.with_release_type = '2|3'; // limited + wide theatrical
        params.region = 'US';
      }
    } else {
      let field = sortFieldFor(mediaType, sortKey);
      let order = sortOrder;
      if (sortKey === 'popularity') { field = 'popularity'; order = 'desc'; }
      params.sort_by = `${field}.${order}`;
      params[`${dateField}.lte`] = today;

      // Vote floors keep each sort meaningful. Without them TMDB happily returns
      // titles with a couple of votes and no artwork.
      if (sortKey === 'popularity') {
        params['vote_count.gte'] = '50';
      } else if (sortKey === 'rating') {
        // Needs to be high: at a few hundred votes a handful of obscure recent
        // titles sit on a perfect average and outrank the actual classics.
        params['vote_count.gte'] = narrowed ? (isSeries ? '100' : '300') : (isSeries ? '1000' : '3000');
      } else if (sortKey === 'release' && order === 'desc') {
        // "Newest" otherwise lists every unknown title released today.
        params['vote_count.gte'] = '20';
      } else if (sortKey === 'name') {
        // TMDB always orders by the ORIGINAL title while the cards show the
        // localized one, so a mixed-script catalogue looks unsorted (a Z-A page
        // opening on "On the Wire" whose original title is CJK). Limiting to
        // English-original titles makes the ordering match what is displayed.
        // An explicit Language filter below overrides this default.
        params['vote_count.gte'] = narrowed ? (isSeries ? '50' : '200') : (isSeries ? '200' : '1000');
        params.with_original_language = 'en';
      }
    }

    const genre = sanitizeToken(body.genre, 60);
    if (genre && genreNameToId) {
      const id = genreNameToId[genre.toLowerCase()];
      if (id) params.with_genres = String(id);
    }

    // ── Advanced filters (discover-only; TMDB /search ignores these) ──────────
    const year = clampInt(body.year, 1874, new Date().getFullYear() + 10, 0);
    if (year) {
      params[mediaType === 'series' ? 'first_air_date_year' : 'primary_release_year'] = String(year);
    }

    const minRating = Number(body.minRating);
    if (!Number.isNaN(minRating) && minRating > 0 && minRating <= 10) {
      params['vote_average.gte'] = String(minRating);
      // Keep a floor of votes so the rating threshold is meaningful.
      if (!params['vote_count.gte']) params['vote_count.gte'] = '50';
    }

    // ISO 639-1 language code (letters only, e.g. "en", "ja").
    const language = sanitizeToken(body.language, 12).replace(/[^a-zA-Z-]/g, '');
    if (language) params.with_original_language = language;

    // Runtime buckets (movies only - TV runtime is per-episode and misleading).
    if (mediaType === 'movie' && RUNTIME_BUCKETS[body.runtime]) {
      const b = RUNTIME_BUCKETS[body.runtime];
      if (b.gte != null) params['with_runtime.gte'] = String(b.gte);
      if (b.lte != null) params['with_runtime.lte'] = String(b.lte);
    }

    // Series-only: with_status (0-5) and with_type (0-6).
    if (mediaType === 'series') {
      const status = clampInt(body.status, 0, 5, -1);
      if (status >= 0) params.with_status = String(status);
      const type = clampInt(body.type, 0, 6, -1);
      if (type >= 0) params.with_type = String(type);
    }

    return { params, limit };
  }

  // TMDB serves 20 results per page. The grid asks for up to 24, so fetch the
  // page(s) that cover [offset, offset+limit) and return exactly that window.
  async function fetchTmdbWindow(pathPart, baseParams, offset, limit) {
    const startPage = Math.floor(offset / 20) + 1;
    const endPage = Math.floor((offset + limit - 1) / 20) + 1;
    let all = [];
    let ok = false;
    for (let p = startPage; p <= endPage; p++) {
      const resp = await tmdbFetch(pathPart, Object.assign({}, baseParams, { page: String(p) }));
      if (!resp.ok) { if (!ok) return { ok: false, results: [] }; break; }
      ok = true;
      const d = await resp.json();
      const chunk = Array.isArray(d.results) ? d.results : [];
      all = all.concat(chunk);
      if (chunk.length < 20) break; // reached the last page
    }
    const start = offset % 20;
    return { ok, results: all.slice(start, start + limit) };
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
        // Detail views want the rich extras (cast, trailer, providers, similar),
        // so fetch TMDB live; only fall back to the stored core row if that fails.
        try {
          const response = await tmdbFetch(`/${endpoint}/${detailId}`, {
            language: 'en-US',
            append_to_response: 'credits,videos,recommendations,watch/providers'
          });
          if (response.ok) {
            const data = await response.json();
            const normalized = normalizeTmdb(mediaType, data);
            if (normalized) {
              const rel = await collectionRelations(data, normalized.id).catch(() => []);
              if (hasRelations(rel)) normalized.relations = rel;
            }
            const payload = normalized ? [normalized] : [];
            cache.set(cacheKey, payload, TTL.detail);
            persistMedia(payload).catch(() => {});
            res.setHeader('X-Cache', 'MISS');
            return res.json(payload);
          }
        } catch (_) { /* fall through to DB */ }

        const fromDb = await loadDetailFromDb(mediaType, detailId);
        if (fromDb) {
          cache.set(cacheKey, fromDb, TTL.detail);
          res.setHeader('X-Cache', 'DB');
          return res.json(fromDb);
        }
        return res.status(502).json({ error: 'TMDB API error' });
      }

      // list / search
      const maps = await getGenreMaps(mediaType).catch(() => ({ byId: {}, byName: {} }));
      const search = sanitizeToken(body.search, 80);

      const offset = clampInt(body.offset, 0, 5000, 0);
      let window;
      if (search) {
        const limit = clampInt(body.limit, 1, 50, 20);
        window = await fetchTmdbWindow(`/search/${endpoint}`, {
          query: search,
          include_adult: 'false',
          language: 'en-US'
        }, offset, limit);
      } else {
        const built = buildDiscoverParams(mediaType, body, maps.byName);
        const base = Object.assign({}, built.params);
        delete base.page; // the window helper drives pagination
        window = await fetchTmdbWindow(`/discover/${endpoint}`, base, offset, built.limit);
      }

      if (!window.ok) {
        const degraded = await serveDegradedList(res, mediaType, body, cacheKey);
        if (degraded) return;
        return res.status(502).json({ error: 'TMDB API error' });
      }

      // Safety net for anime that slipped past the keyword filter, and for the
      // search endpoint, which accepts no keyword parameters at all.
      const rows = mediaType === 'series'
        ? window.results.filter((item) => !isJapaneseAnimation(item))
        : window.results;

      let normalized = rows
        .map((item) => normalizeTmdb(mediaType, item, maps.byId))
        .filter(Boolean);

      // TMDB search already tolerates typos and ranks by relevance; this only
      // lifts exact / prefix title matches above near-matches (no results dropped).
      if (search) normalized = rankSearchResults(normalized, search, (m) => m && m.name);

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

  // Original-language options for the discover filter, sourced from TMDB itself
  // (not hardcoded). Trimmed to the languages that back real catalogue volume.
  const LANGUAGE_ALLOW = new Set([
    'en', 'ja', 'ko', 'zh', 'fr', 'es', 'de', 'it', 'pt', 'ru',
    'hi', 'th', 'tr', 'sv', 'da', 'no', 'nl', 'pl', 'fi', 'ar'
  ]);
  router.post('/languages', async (req, res) => {
    try {
      const cached = cache.get('languages');
      if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }
      const response = await tmdbFetch('/configuration/languages', {});
      const data = await response.json();
      if (!response.ok || !Array.isArray(data)) {
        return res.status(502).json({ error: 'TMDB API error' });
      }
      const list = data
        .filter((l) => l && l.iso_639_1 && LANGUAGE_ALLOW.has(l.iso_639_1))
        .map((l) => ({ code: l.iso_639_1, name: l.english_name || l.name || l.iso_639_1 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      cache.set('languages', list, TTL.genres);
      res.setHeader('X-Cache', 'MISS');
      res.json(list);
    } catch (error) {
      sendError(res, error, 'Failed to fetch languages from TMDB');
    }
  });

  return router;
};
