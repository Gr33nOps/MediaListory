/* Where a title's season list comes from.

   TMDB returns the whole season list on the series detail response, so listing
   the seasons for a show costs one call and no per-season requests. Episode
   counts come with it, which is also what fixes the missing episode_count on
   series rows.

   Anime is deliberately empty here. Kitsu models each season as its own
   top-level entry rather than as a child of one show, so an anime's "seasons"
   are its sibling entries in the catalog, reached through the sequel chain, not
   something a provider hands back for a single id. That is franchise grouping
   and it lives elsewhere; returning nothing here keeps this module honest rather
   than pretending it can answer. */

const TMDB_BASE = 'https://api.themoviedb.org/3';

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

/* Called with the catalog row. Returns [] for anything without a season concept,
   which the caller treats as "this title simply has no seasons". */
async function fetchSeasons(game) {
  if (!game) return [];
  if (game.media_type === 'series' && game.tmdb_id) {
    return fetchTmdbSeasons(game.tmdb_id);
  }
  return [];
}

module.exports = { fetchSeasons, fetchTmdbSeasons };
