const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { createTtlCache } = require('./cache');
const { sanitizeToken, clampInt } = require('./igdbUtils');
const { mediaToRow } = require('./tmdbUtils');
const { normalizeKitsuAnime, categoriesFromIncluded } = require('./kitsuUtils');

const KITSU_BASE = 'https://kitsu.io/api/edge';

const TTL = { genres: 24 * 60 * 60 * 1000, list: 3 * 60 * 1000, detail: 30 * 60 * 1000 };

// Our sort keys -> Kitsu sort params.
function kitsuSort(sortKey, sortOrder) {
  if (sortKey === 'rating') return '-averageRating';
  if (sortKey === 'name') return 'canonicalTitle';
  if (sortKey === 'release') return sortOrder === 'asc' ? 'startDate' : '-startDate';
  return '-userCount'; // popularity (default)
}

module.exports = (verifyToken, checkBanned, db) => {
  const router = express.Router();
  const cache = createTtlCache();

  let lastCall = 0;
  const MIN_DELAY = 120;
  async function respectRateLimit() {
    const now = Date.now();
    const delta = now - lastCall;
    if (delta < MIN_DELAY) await new Promise((r) => setTimeout(r, MIN_DELAY - delta));
    lastCall = Date.now();
  }

  async function kitsuFetch(pathAndQuery) {
    await respectRateLimit();
    return fetch(`${KITSU_BASE}${pathAndQuery}`, {
      headers: { Accept: 'application/vnd.api+json' }
    });
  }

  function sendError(res, error, fallback) {
    console.error(fallback, error.message);
    const body = { error: fallback };
    if (process.env.NODE_ENV !== 'production') body.message = error.message;
    return res.status(500).json(body);
  }

  // Category (genre) cache: list + title->slug map.
  async function getCategories() {
    const cached = cache.get('categories');
    if (cached) return cached;
    const res = await kitsuFetch('/categories?page[limit]=40&sort=-totalMediaCount');
    const data = await res.json();
    if (!res.ok) throw new Error('Kitsu categories error');
    const list = (data.data || [])
      .map((c) => ({ id: c.attributes.slug, name: c.attributes.title }))
      .filter((c) => c.name);
    const bySlugTitle = {};
    list.forEach((c) => { bySlugTitle[c.name.toLowerCase()] = c.id; });
    const maps = { list, titleToSlug: bySlugTitle };
    cache.set('categories', maps, TTL.genres);
    return maps;
  }

  function dbRowToNormalized(row) {
    const parse = (v) => (typeof v === 'string' ? JSON.parse(v || '[]') : v || []);
    return {
      id: row.game_id,
      media_type: 'anime',
      provider: 'kitsu',
      provider_id: row.provider_id,
      name: row.name,
      background_image: row.background_image || null,
      backdrop_image: row.background_image || null,
      description: row.description || '',
      released: row.released ? new Date(row.released).toISOString().slice(0, 10) : null,
      rating: row.rating != null ? Number(row.rating) : null,
      metacritic_score: row.metacritic_score != null ? Number(row.metacritic_score) : null,
      number_of_episodes: row.episode_count != null ? row.episode_count : null,
      genres: parse(row.genres),
      developers: [],
      publishers: []
    };
  }

  async function loadListFromDb(body) {
    if (!db) return null;
    try {
      const limit = clampInt(body.limit, 1, 50, 20);
      const offset = clampInt(body.offset, 0, 5000, 0);
      const search = sanitizeToken(body.search, 80);
      let q = db('games').where({ media_type: 'anime' }).select('*');
      if (search) q = q.where('name', 'ilike', `%${search}%`);
      q = q.orderBy('metacritic_score', 'desc');
      const rows = await q.limit(limit).offset(offset);
      if (!rows.length) return null;
      return rows.map(dbRowToNormalized);
    } catch (_) { return null; }
  }

  async function persist(items) {
    if (!db || !Array.isArray(items) || !items.length) return;
    for (const media of items) {
      const row = mediaToRow(media);
      if (!row) continue;
      try {
        await db('games').insert(row).onConflict('game_id').merge({
          name: row.name, description: row.description, background_image: row.background_image,
          rating: row.rating, metacritic_score: row.metacritic_score, released: row.released,
          genres: row.genres, provider: row.provider, provider_id: row.provider_id,
          media_type: row.media_type, episode_count: row.episode_count
        });
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') console.warn('Kitsu write-through skipped:', err.message);
      }
    }
  }

  router.use(verifyToken, checkBanned);

  router.post('/anime', async (req, res) => {
    if (req.body && typeof req.body.query === 'string') {
      return res.status(400).json({ error: 'Raw Kitsu queries are not allowed' });
    }
    const body = req.body || {};
    const detailId = clampInt(body.id, 1, Number.MAX_SAFE_INTEGER, 0);
    const cacheKey = detailId
      ? `detail:${detailId}`
      : `list:${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}`;

    const cached = cache.get(cacheKey);
    if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }

    try {
      if (detailId) {
        const res2 = await kitsuFetch(`/anime/${detailId}?include=categories`);
        const data = await res2.json();
        if (!res2.ok || !data.data) return res.status(res2.status).json({ error: 'Kitsu API error' });
        const cats = categoriesFromIncluded(data.included);
        const normalized = normalizeKitsuAnime(data.data, cats);
        if (normalized) {
          // Characters ("cast") give anime the same richness as movies/shows.
          // A failure here must never break the detail response.
          try {
            const cRes = await kitsuFetch(`/anime/${detailId}/characters?include=character&page[limit]=20`);
            const cJson = await cRes.json();
            if (cRes.ok && Array.isArray(cJson.data)) {
              const chars = {};
              (cJson.included || []).forEach((r) => {
                if (r && r.type === 'characters' && r.id) chars[r.id] = r.attributes || {};
              });
              normalized.cast = cJson.data.map((mc) => {
                const rel = mc.relationships && mc.relationships.character && mc.relationships.character.data;
                const c = rel && chars[rel.id];
                if (!c || !c.name) return null;
                const img = c.image || {};
                const main = mc.attributes && mc.attributes.role === 'main';
                return {
                  name: c.name,
                  character: main ? 'Main character' : 'Supporting',
                  image: img.original || img.large || img.medium || null,
                  _main: main
                };
              }).filter(Boolean)
                // Main characters first; media-characters has no server-side sort for this.
                .sort((a, b) => (b._main ? 1 : 0) - (a._main ? 1 : 0))
                .slice(0, 12)
                .map(({ _main, ...c }) => c);
            }
          } catch (_) {}
        }
        const payload = normalized ? [normalized] : [];
        cache.set(cacheKey, payload, TTL.detail);
        persist(payload).catch(() => {});
        res.setHeader('X-Cache', 'MISS');
        return res.json(payload);
      }

      const limit = clampInt(body.limit, 1, 20, 20); // Kitsu max page size is 20
      const offset = clampInt(body.offset, 0, 5000, 0);
      const search = sanitizeToken(body.search, 80);
      const sortKey = body.sort || 'popularity';
      const comingSoon = !!body.comingSoon || sortKey === 'coming';
      const trending = !!body.trending && !search && !comingSoon;

      const params = ['include=categories', `page[limit]=${limit}`, `page[offset]=${offset}`];
      if (search) {
        params.push(`filter[text]=${encodeURIComponent(search)}`);
      } else {
        params.push(`sort=${encodeURIComponent(comingSoon ? 'startDate' : kitsuSort(sortKey, body.sortOrder))}`);
        if (comingSoon) params.push('filter[status]=upcoming');
      }
      const genre = sanitizeToken(body.genre, 60);
      if (genre) {
        try {
          const cats = await getCategories();
          const slug = cats.titleToSlug[genre.toLowerCase()] || genre.toLowerCase().replace(/\s+/g, '-');
          params.push(`filter[categories]=${encodeURIComponent(slug)}`);
        } catch (_) {}
      }

      // Kitsu exposes a dedicated, genuinely-trending feed at /trending/anime.
      const listPath = trending
        ? `/trending/anime?include=categories`
        : `/anime?${params.join('&')}`;
      const response = await kitsuFetch(listPath);
      const data = await response.json();
      if (!response.ok) {
        const degraded = await loadListFromDb(body);
        if (degraded && degraded.length) { res.setHeader('X-Cache', 'DEGRADED'); return res.json(degraded); }
        return res.status(response.status).json({ error: 'Kitsu API error' });
      }
      const cats = categoriesFromIncluded(data.included);
      const normalized = (data.data || []).map((it) => normalizeKitsuAnime(it, cats)).filter(Boolean);
      cache.set(cacheKey, normalized, TTL.list);
      persist(normalized).catch(() => {});
      res.setHeader('X-Cache', 'MISS');
      return res.json(normalized);
    } catch (error) {
      if (!detailId) {
        const degraded = await loadListFromDb(body);
        if (degraded && degraded.length) { res.setHeader('X-Cache', 'DEGRADED'); return res.json(degraded); }
      }
      return sendError(res, error, 'Failed to fetch from Kitsu');
    }
  });

  router.post('/genres', async (req, res) => {
    try {
      const maps = await getCategories();
      res.json(maps.list);
    } catch (error) {
      sendError(res, error, 'Failed to fetch genres from Kitsu');
    }
  });

  return router;
};
