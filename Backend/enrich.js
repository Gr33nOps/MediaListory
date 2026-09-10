/**
 * Secondary data for detail views: game prices, anime scores and themes,
 * upcoming episodes.
 *
 * Everything here is strictly additive. The routes always answer 200, even when
 * every source failed, because the detail page has already rendered by the time
 * it asks - a failure here removes a section, it never shows an error. The
 * `X-Enrich-Sources` header names the sources that actually returned, mirroring
 * the X-Cache / X-Degraded convention the core proxies use.
 *
 * None of this is touched during search or browse. Enrichment is fetched only
 * when a single title is opened, which is what keeps these quotas survivable.
 */

const express = require('express');
const { lookup, fetchJson, sourceEnabled } = require('./externalApi');

/* Deliberately not clampInt: that clamps into range, so an id of 0 would come
   back as 1 and quietly enrich the wrong title. A bad id is an error here. */
function positiveId(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d{1,15}$/.test(raw)) return 0;
  const n = Number(raw);
  return n >= 1 ? n : 0;
}

/* Every upstream call below is strict: a failure throws instead of returning
   null, so lookup() never caches an outage as "this title has none". The
   next viewer simply gets a fresh attempt. */
const TTL = {
  deals:    30 * 60 * 1000,
  stores:   24 * 60 * 60 * 1000,
  mal:      12 * 60 * 60 * 1000,
  themes:    7 * 24 * 60 * 60 * 1000,
  episodes:  6 * 60 * 60 * 1000
};

const CHEAPSHARK = 'https://www.cheapshark.com/api/1.0';
const JIKAN = 'https://api.jikan.moe/v4';
const ANIMETHEMES = 'https://api.animethemes.moe';
const TVMAZE = 'https://api.tvmaze.com';

module.exports = (verifyToken, checkBanned, deps = {}) => {
  const router = express.Router();
  const ids = deps.externalIds || {};

  // ---- games: current best price ------------------------------------------

  /** storeID -> store name. One call a day covers every game. */
  function storeNames() {
    return lookup('cheapshark:stores', TTL.stores, async () => {
      const rows = await fetchJson(CHEAPSHARK + '/stores', { strict: true });
      if (!Array.isArray(rows)) return null;
      const map = {};
      rows.forEach((s) => {
        if (s && s.storeID && s.storeName && s.isActive) map[String(s.storeID)] = s.storeName;
      });
      return Object.keys(map).length ? map : null;
    });
  }

  async function bestDeal(igdbId) {
    if (!sourceEnabled('ENRICH_DEALS')) return null;
    if (typeof ids.steamAppId !== 'function') return null;

    const appId = await ids.steamAppId(igdbId);
    if (!appId) return null; // No Steam release - nothing for CheapShark to price.

    return lookup('deal:' + appId, TTL.deals, async () => {
      const found = await fetchJson(CHEAPSHARK + '/games?steamAppID=' + encodeURIComponent(appId), { strict: true });
      const gameId = Array.isArray(found) && found[0] && found[0].gameID;
      if (!gameId) return null;

      const [detail, stores] = await Promise.all([
        fetchJson(CHEAPSHARK + '/games?id=' + encodeURIComponent(gameId), { strict: true }),
        storeNames()
      ]);
      const deals = (detail && Array.isArray(detail.deals)) ? detail.deals : [];
      if (!deals.length) return null;

      const cheapest = deals.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
      const price = Number(cheapest.price);
      const retail = Number(cheapest.retailPrice);
      if (!Number.isFinite(price)) return null;

      const discounted = Number.isFinite(retail) && retail > price;
      return {
        // CheapShark quotes USD only; the UI says so rather than implying local currency.
        currency: 'USD',
        price: price.toFixed(2),
        retail: discounted ? retail.toFixed(2) : null,
        percentOff: discounted ? Math.round(((retail - price) / retail) * 100) : 0,
        store: (stores && stores[String(cheapest.storeID)]) || null,
        url: cheapest.dealID
          ? 'https://www.cheapshark.com/redirect?dealID=' + encodeURIComponent(cheapest.dealID)
          : null
      };
    });
  }

  // ---- anime: MyAnimeList score + opening/ending themes --------------------

  function malSummary(malId) {
    return lookup('mal:' + malId, TTL.mal, async () => {
      const body = await fetchJson(JIKAN + '/anime/' + encodeURIComponent(malId), { strict: true });
      const d = body && body.data;
      if (!d || d.score == null) return null;
      return {
        score: Number(d.score),
        scoredBy: Number(d.scored_by) || null,
        rank: d.rank != null ? Number(d.rank) : null,
        studios: (Array.isArray(d.studios) ? d.studios : [])
          .map((s) => s && s.name).filter(Boolean).slice(0, 3),
        // e.g. "Saturdays at 01:00 (JST)" - only meaningful while a show airs.
        broadcast: (d.airing && d.broadcast && d.broadcast.string) || null,
        url: d.url || null
      };
    });
  }

  function themes(malId) {
    return lookup('themes:' + malId, TTL.themes, async () => {
      const body = await fetchJson(
        ANIMETHEMES + '/anime?filter[has]=resources&filter[site]=MyAnimeList' +
        '&filter[external_id]=' + encodeURIComponent(malId) +
        '&include=animethemes.song.artists',
        { strict: true }
      );
      const anime = body && Array.isArray(body.anime) && body.anime[0];
      const list = (anime && Array.isArray(anime.animethemes)) ? anime.animethemes : [];
      if (!list.length) return null;

      const mapped = list.map((t) => ({
        type: String(t.type || '').toUpperCase(),
        sequence: t.sequence != null ? Number(t.sequence) : 0,
        // "OP" / "ED" plus its sequence when a show has more than one.
        label: String(t.type || '') + (t.sequence != null ? String(t.sequence) : ''),
        title: (t.song && t.song.title) || null,
        artists: (t.song && Array.isArray(t.song.artists) ? t.song.artists : [])
          .map((a) => a && a.name).filter(Boolean).join(', ') || null
      })).filter((t) => t.label && t.title);

      if (!mapped.length) return null;
      // Openings before endings, then by sequence - the order you meet them in.
      // Sorting on the label alone would put "ED1" ahead of "OP1" alphabetically.
      const rank = (t) => (t.type === 'OP' ? 0 : t.type === 'ED' ? 1 : 2);
      mapped.sort((a, b) => rank(a) - rank(b) || a.sequence - b.sequence);
      return mapped.slice(0, 12).map((t) => ({ label: t.label, title: t.title, artists: t.artists }));
    });
  }

  // ---- series: what airs next ---------------------------------------------

  function episodes(tvmazeId) {
    return lookup('tvmaze:' + tvmazeId, TTL.episodes, async () => {
      const show = await fetchJson(
        TVMAZE + '/shows/' + encodeURIComponent(tvmazeId) +
        '?embed[]=nextepisode&embed[]=previousepisode',
        { strict: true }
      );
      if (!show) return null;
      const embedded = show._embedded || {};

      // Specials and TV movies come through with a null episode number, so the
      // number is only shown when there actually is one.
      const shape = (ep) => (ep ? {
        season: ep.season != null ? Number(ep.season) : null,
        number: ep.number != null ? Number(ep.number) : null,
        name: ep.name || null,
        airdate: ep.airstamp || ep.airdate || null
      } : null);

      const next = shape(embedded.nextepisode);
      const previous = shape(embedded.previousepisode);
      if (!next && !previous) return null;

      return {
        status: show.status || null, // Running | Ended | To Be Determined
        next,
        previous,
        url: show.url || null
      };
    });
  }

  // ---- routes --------------------------------------------------------------

  /** Answer with whatever came back, naming the sources that returned. */
  function respond(res, parts) {
    const present = Object.keys(parts).filter((k) => parts[k] != null);
    res.setHeader('X-Enrich-Sources', present.join(',') || 'none');
    return res.json(parts);
  }

  router.use(verifyToken, checkBanned);

  router.get('/game/:igdbId', async (req, res) => {
    const igdbId = positiveId(req.params.igdbId);
    if (!igdbId) return res.status(400).json({ error: 'Invalid game id' });

    const deal = await bestDeal(igdbId).catch(() => null);
    return respond(res, { deal });
  });

  router.get('/anime/:kitsuId', async (req, res) => {
    const kitsuId = positiveId(req.params.kitsuId);
    if (!kitsuId) return res.status(400).json({ error: 'Invalid anime id' });

    if (!sourceEnabled('ENRICH_ANIME') || typeof ids.malId !== 'function') {
      return respond(res, { mal: null, themes: null });
    }

    const malId = await ids.malId(kitsuId).catch(() => null);
    if (!malId) return respond(res, { mal: null, themes: null });

    const [mal, theme] = await Promise.all([
      malSummary(malId).catch(() => null),
      themes(malId).catch(() => null)
    ]);
    return respond(res, { mal, themes: theme });
  });

  router.get('/series/:tmdbId', async (req, res) => {
    const tmdbId = positiveId(req.params.tmdbId);
    if (!tmdbId) return res.status(400).json({ error: 'Invalid series id' });

    if (!sourceEnabled('ENRICH_EPISODES') || typeof ids.tvmazeId !== 'function') {
      return respond(res, { episodes: null });
    }

    const tvmazeId = await ids.tvmazeId(tmdbId).catch(() => null);
    if (!tvmazeId) return respond(res, { episodes: null });

    const eps = await episodes(tvmazeId).catch(() => null);
    return respond(res, { episodes: eps });
  });

  return router;
};
