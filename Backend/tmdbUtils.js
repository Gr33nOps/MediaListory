/** Pure helpers for TMDB (movies + series) mapping / normalization (unit-tested).
 *
 * MediaListory stores every media kind in the same `games` table, discriminated
 * by `media_type` ('game' | 'movie' | 'series'). Movies and series come from TMDB
 * and share one external-ref scheme: `tmdb_movie_<id>` / `tmdb_series_<id>`.
 * Games keep their existing `igdb_<id>` refs (see igdbUtils.js).
 */

const { slugify } = require('./igdbUtils');

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';

const MEDIA_TYPES = ['game', 'movie', 'series'];

// TMDB uses 'movie' and 'tv'; MediaListory uses 'movie' and 'series'.
function tmdbEndpointFor(mediaType) {
  if (mediaType === 'series') return 'tv';
  if (mediaType === 'movie') return 'movie';
  return null;
}

function tmdbImage(pathPart, size) {
  if (!pathPart) return null;
  const clean = String(pathPart).trim();
  if (!clean) return null;
  if (/^https?:\/\//i.test(clean)) return clean;
  return TMDB_IMAGE_BASE + (size || 'w500') + (clean.charAt(0) === '/' ? '' : '/') + clean;
}

function externalRef(mediaType, id) {
  const n = parseInt(id, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  if (mediaType === 'movie') return `tmdb_movie_${n}`;
  if (mediaType === 'series') return `tmdb_series_${n}`;
  if (mediaType === 'game') return `igdb_${n}`;
  return null;
}

/** Parse a universal client media id into { media_type, id }. */
function parseMediaRef(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  let m = s.match(/^tmdb_movie_(\d+)$/i);
  if (m) return { media_type: 'movie', id: parseInt(m[1], 10) };
  m = s.match(/^tmdb_series_(\d+)$/i);
  if (m) return { media_type: 'series', id: parseInt(m[1], 10) };
  m = s.match(/^igdb_(\d+)$/i);
  if (m) return { media_type: 'game', id: parseInt(m[1], 10) };
  return null;
}

function isValidMediaType(mediaType) {
  return MEDIA_TYPES.includes(mediaType);
}

// TMDB vote_average is 0-10. Games store rating on a 0-5 scale and a 0-100
// "metacritic_score". Keep both consistent so mixed libraries sort/average sanely.
function ratingFromVote(voteAverage, voteCount) {
  const avg = Number(voteAverage);
  const count = Number(voteCount || 0);
  if (!avg || count < 5) return { rating: null, metacritic_score: null };
  return {
    rating: Number((avg / 2).toFixed(2)),
    metacritic_score: Math.round(avg * 10)
  };
}

function namesFrom(list, key) {
  return (Array.isArray(list) ? list : [])
    .map((item) => (item && (key ? item[key] : item.name)) || (item && item.name))
    .filter(Boolean)
    .map((name) => ({ name: String(name) }));
}

// Resolve TMDB genre_ids -> [{id,name}] using a { id: name } map, or pass through
// an already-resolved `genres` array (detail responses include it directly).
function resolveGenres(obj, genreMap) {
  if (Array.isArray(obj.genres) && obj.genres.length) {
    return obj.genres
      .filter((g) => g && (g.name || g.id))
      .map((g) => ({ id: g.id != null ? g.id : null, name: g.name || (genreMap && genreMap[g.id]) || '' }))
      .filter((g) => g.name);
  }
  const ids = Array.isArray(obj.genre_ids) ? obj.genre_ids : [];
  const map = genreMap || {};
  return ids.map((id) => ({ id, name: map[id] || '' })).filter((g) => g.name);
}

function directorsFrom(credits) {
  const crew = credits && Array.isArray(credits.crew) ? credits.crew : [];
  return crew
    .filter((c) => c && c.job === 'Director' && c.name)
    .map((c) => ({ name: c.name }));
}

/** TMDB movie -> normalized MediaListory media object (client-facing shape). */
function normalizeTmdbMovie(movie, genreMap) {
  if (!movie || !movie.id) return null;
  const released = movie.release_date || null;
  const { rating, metacritic_score } = ratingFromVote(movie.vote_average, movie.vote_count);
  const credits = movie.credits || {};
  return {
    id: externalRef('movie', movie.id),
    media_type: 'movie',
    tmdb_id: movie.id,
    name: movie.title || movie.original_title || 'Untitled',
    background_image: tmdbImage(movie.poster_path, 'w500'),
    backdrop_image: tmdbImage(movie.backdrop_path, 'w780'),
    description: movie.overview || '',
    released: released || null,
    rating,
    metacritic_score,
    runtime: movie.runtime || null,
    genres: resolveGenres(movie, genreMap),
    developers: directorsFrom(credits),               // directors
    publishers: namesFrom(movie.production_companies) // studios
  };
}

/** TMDB TV series -> normalized MediaListory media object (client-facing shape). */
function normalizeTmdbSeries(series, genreMap) {
  if (!series || !series.id) return null;
  const released = series.first_air_date || null;
  const { rating, metacritic_score } = ratingFromVote(series.vote_average, series.vote_count);
  return {
    id: externalRef('series', series.id),
    media_type: 'series',
    tmdb_id: series.id,
    name: series.name || series.original_name || 'Untitled',
    background_image: tmdbImage(series.poster_path, 'w500'),
    backdrop_image: tmdbImage(series.backdrop_path, 'w780'),
    description: series.overview || '',
    released: released || null,
    rating,
    metacritic_score,
    number_of_seasons: series.number_of_seasons || null,
    number_of_episodes: series.number_of_episodes || null,
    genres: resolveGenres(series, genreMap),
    developers: namesFrom(series.created_by), // creators
    publishers: namesFrom(series.networks)    // networks
  };
}

function normalizeTmdb(mediaType, obj, genreMap) {
  if (mediaType === 'movie') return normalizeTmdbMovie(obj, genreMap);
  if (mediaType === 'series') return normalizeTmdbSeries(obj, genreMap);
  return null;
}

/** Normalized media object -> row for the shared `games` table. */
function mediaToRow(media) {
  if (!media || !media.media_type || !media.tmdb_id) return null;
  const ref = externalRef(media.media_type, media.tmdb_id);
  if (!ref) return null;
  return {
    game_id: ref,
    igdb_id: null,
    tmdb_id: media.tmdb_id,
    media_type: media.media_type,
    name: media.name,
    slug: slugify(media.name),
    description: media.description || null,
    background_image: media.background_image || null,
    rating: media.rating != null ? media.rating : null,
    metacritic_score: media.metacritic_score != null ? media.metacritic_score : null,
    released: media.released || null,
    playtime: 0,
    genres: JSON.stringify(media.genres || []),
    platforms: JSON.stringify(media.platforms || []),
    publishers: JSON.stringify(media.publishers || []),
    developers: JSON.stringify(media.developers || [])
  };
}

module.exports = {
  MEDIA_TYPES,
  TMDB_IMAGE_BASE,
  tmdbEndpointFor,
  tmdbImage,
  externalRef,
  parseMediaRef,
  isValidMediaType,
  ratingFromVote,
  resolveGenres,
  normalizeTmdbMovie,
  normalizeTmdbSeries,
  normalizeTmdb,
  mediaToRow
};
