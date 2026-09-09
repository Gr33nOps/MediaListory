/* Where a title's season list comes from.

   TMDB returns the whole season list on the series detail response, so listing
   the seasons for a show costs one call and no per-season requests. Episode
   counts come with it, which is also what fixes the missing episode_count on
   series rows.

   Anime has no such endpoint. Kitsu models each season as its own top-level
   entry rather than as a child of one show, so an anime's "seasons" are its
   sibling entries. One text search for the franchise title returns them all in
   a single call, and Backend/franchise.js decides which results are genuinely
   the same franchise. Anything without a real episode count, and anything that
   is not a TV or ONA run, is left out: specials, recaps and movies are not
   seasons and should not become numbered ones. */

const { membersToSeasons, franchiseOf } = require('./franchise');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const KITSU_BASE = 'https://kitsu.io/api/edge';

function tmdbAuth() {
  const bearer = (process.env.TMDB_ACCESS_TOKEN || '').trim();
  const key = (process.env.TMDB_API_KEY || '').trim();
  return { bearer, key };
}

function tmdbImage(path, size = 'w300') {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

async function fetchTmdbSeasons(tmdbId) {
  const { bearer, key } = tmdbAuth();
  if (!bearer && !key) return [];

  const params = new URLSearchParams();
  const headers = { Accept: 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else params.set('api_key', key);

  const res = await fetch(`${TMDB_BASE}/tv/${encodeURIComponent(tmdbId)}?${params.toString()}`, { headers });
  if (!res.ok) return [];
  const body = await res.json();

  return (body.seasons || [])
    // Season 0 is TMDB's bucket for specials and one-offs. Leaving it out keeps
    // the dropdown to the seasons people actually think of as seasons.
    .filter(s => Number(s.season_number) >= 1 && Number(s.episode_count) > 0)
    .map(s => ({
      season_number: Number(s.season_number),
      name: s.name || `Season ${s.season_number}`,
      episode_count: Number(s.episode_count) || null,
      air_date: s.air_date || null,
      poster_image: tmdbImage(s.poster_path)
    }));
}

async function fetchKitsuSeasons(name) {
  const { base } = franchiseOf(name);
  if (!base) return [];

  const url = `${KITSU_BASE}/anime?filter[text]=${encodeURIComponent(base)}&page[limit]=20`;
  const res = await fetch(url, { headers: { Accept: 'application/vnd.api+json' } });
  if (!res.ok) return [];
  const body = await res.json();

  const candidates = (body.data || [])
    .map((a) => {
      const at = a.attributes || {};
      return {
        id: `kitsu_${a.id}`,
        name: at.canonicalTitle || (at.titles && (at.titles.en || at.titles.en_jp)) || '',
        released: at.startDate || null,
        background_image: (at.posterImage && (at.posterImage.large || at.posterImage.medium)) || null,
        number_of_episodes: at.episodeCount != null ? Number(at.episodeCount) : null,
        subtype: at.subtype || null
      };
    })
    .filter((m) => m.name);

  const seasons = membersToSeasons(base, candidates);
  /* One entry is not a season list, it is just the show itself. Showing a lone
     "Season 1" that duplicates the title would be noise, so say nothing. */
  return seasons.length > 1 ? seasons : [];
}

/* Called with the catalog row. Returns [] for anything without a season concept,
   which the caller treats as "this title simply has no seasons". */
async function fetchSeasons(game) {
  if (!game) return [];
  if (game.media_type === 'series' && game.tmdb_id) {
    return fetchTmdbSeasons(game.tmdb_id);
  }
  if (game.media_type === 'anime' && game.name) {
    return fetchKitsuSeasons(game.name);
  }
  return [];
}

module.exports = { fetchSeasons, fetchTmdbSeasons, fetchKitsuSeasons };
