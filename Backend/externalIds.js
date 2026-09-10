/**
 * Cross-API id resolution.
 *
 * Every secondary source is reached through an id the core APIs already know
 * about - never through a title match. IGDB records a game's Steam appid,
 * Kitsu records an anime's MyAnimeList id, TMDB records a show's IMDb id. That
 * makes each hop exact, so a secondary source can never attach the wrong film's
 * price or the wrong show's episode list to a title.
 *
 * Resolved ids are written to `media_external_ids` because they are stable and
 * expensive to rediscover: the API host sleeps on the free tier, and the
 * in-process cache dies with it. Confirmed absences are stored too (a NULL
 * external_id) so a game with no Steam release is not looked up forever.
 */

const { lookup, fetchJson } = require('./externalApi');

// Positive mappings are effectively permanent. Absences are re-checked
// occasionally: a game can gain a Steam release, a show can gain an IMDb id.
const MISS_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const MEMORY_TTL_MS = 12 * 60 * 60 * 1000;

const KITSU_BASE = 'https://kitsu.io/api/edge';

module.exports = ({ db, igdbFetch, tmdbFetch }) => {
  /** Read a stored mapping. Returns undefined when we have never looked. */
  async function readStored(mediaRef, source) {
    if (!db) return undefined;
    try {
      const row = await db('media_external_ids')
        .where({ media_ref: mediaRef, source })
        .first('external_id', 'checked_at');
      if (!row) return undefined;
      if (row.external_id == null) {
        const age = Date.now() - new Date(row.checked_at).getTime();
        return age > MISS_RECHECK_MS ? undefined : null;
      }
      return row.external_id;
    } catch (_) {
      // Table may not exist yet (migration not applied) - fall back to live.
      return undefined;
    }
  }

  async function writeStored(mediaRef, source, externalId) {
    if (!db) return;
    try {
      await db('media_external_ids')
        .insert({ media_ref: mediaRef, source, external_id: externalId, checked_at: db.fn.now() })
        .onConflict(['media_ref', 'source'])
        .merge({ external_id: externalId, checked_at: db.fn.now() });
    } catch (_) {
      // Never let a cache write break a read path.
    }
  }

  /**
   * Resolve once, remembering the answer in memory and in Postgres.
   * `resolver` returns the external id, or null when the source has none.
   */
  function resolve(mediaRef, source, resolver) {
    return lookup(`xid:${source}:${mediaRef}`, MEMORY_TTL_MS, async () => {
      const stored = await readStored(mediaRef, source);
      if (stored !== undefined) return stored;

      const found = await resolver();
      await writeStored(mediaRef, source, found == null ? null : String(found));
      return found == null ? null : String(found);
    });
  }

  /* IGDB -> Steam appid.
     IGDB's external_games table lists a game's ids on other storefronts. Steam
     is source 1; the uid is the appid CheapShark expects. */
  const IGDB_SOURCE_STEAM = 1;
  function steamAppId(igdbId) {
    const id = Number(igdbId);
    if (!Number.isFinite(id) || id <= 0) return Promise.resolve(null);

    return resolve(`igdb_${id}`, 'steam', async () => {
      if (typeof igdbFetch !== 'function') return null;
      const res = await igdbFetch(
        '/external_games',
        `fields uid, external_game_source; where game = ${id} & external_game_source = ${IGDB_SOURCE_STEAM}; limit 5;`
      );
      // A failed call must throw, not return null: null is cached (and stored)
      // as "this game has no Steam release". Only a real empty answer is null.
      if (!res || !res.ok) throw new Error('IGDB external_games unavailable');
      const rows = await res.json();
      // The source is re-checked here even though the query already filters on
      // it. Trusting the where-clause alone would mean one unexpected row is
      // enough to hand CheapShark a Giant Bomb id and price the wrong game.
      const hit = (Array.isArray(rows) ? rows : []).find(
        (r) => r && r.uid && Number(r.external_game_source) === IGDB_SOURCE_STEAM
      );
      // Steam appids are numeric; anything else is a bad row, not an appid.
      return hit && /^\d+$/.test(String(hit.uid)) ? String(hit.uid) : null;
    });
  }

  /* Kitsu -> MyAnimeList id.
     Kitsu exposes its cross-site mappings as a JSON:API relationship. Note the
     vendor Accept header: kitsu.io answers 406 to plain application/json. */
  function malId(kitsuId) {
    const id = Number(kitsuId);
    if (!Number.isFinite(id) || id <= 0) return Promise.resolve(null);

    return resolve(`kitsu_${id}`, 'mal', async () => {
      const body = await fetchJson(
        `${KITSU_BASE}/anime/${id}/mappings?page[limit]=20`,
        { accept: 'application/vnd.api+json', strict: true }
      );
      const rows = (body && Array.isArray(body.data)) ? body.data : [];
      const hit = rows.find((r) => r && r.attributes && r.attributes.externalSite === 'myanimelist/anime');
      const value = hit && hit.attributes.externalId;
      return value && /^\d+$/.test(String(value)) ? String(value) : null;
    });
  }

  /* TMDB series -> TVmaze id, bridged by IMDb.
     TVmaze indexes shows by their IMDb id, which TMDB hands over on
     /tv/{id}/external_ids. Plenty of shows have no IMDb id recorded, so a null
     here is an ordinary outcome rather than a failure. */
  function tvmazeId(tmdbSeriesId) {
    const id = Number(tmdbSeriesId);
    if (!Number.isFinite(id) || id <= 0) return Promise.resolve(null);

    return resolve(`tmdb_series_${id}`, 'tvmaze', async () => {
      if (typeof tmdbFetch !== 'function') return null;
      const res = await tmdbFetch(`/tv/${id}/external_ids`, {});
      if (res && res.status === 404) return null; // TMDB does not know the show
      if (!res || !res.ok) throw new Error('TMDB external_ids unavailable');
      const body = await res.json();
      const imdb = body && body.imdb_id;
      if (!imdb || !/^tt\d+$/.test(String(imdb))) return null;

      // TVmaze answers 404 for an IMDb id it does not carry - a genuine miss.
      const show = await fetchJson(
        `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdb)}`,
        { strict: true }
      );
      return show && show.id ? String(show.id) : null;
    });
  }

  return { steamAppId, malId, tvmazeId };
};
