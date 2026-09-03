/** Pure helpers for Kitsu (Anime) mapping / normalization (unit-tested).
 *
 * Kitsu is a public JSON:API service (no API key). Anime lives in the shared
 * `games` catalog as media_type='anime', provider='kitsu', ref='kitsu_<id>'.
 */

const { externalRef } = require('./tmdbUtils');

function pickImage(img) {
  if (!img) return null;
  return img.large || img.medium || img.original || img.small || img.tiny || null;
}

// Kitsu averageRating is a 0-100 string. Games store rating on 0-5 + a 0-100 score.
function ratingFromKitsu(avg) {
  const n = Number(avg);
  if (!avg || Number.isNaN(n) || n <= 0) return { rating: null, metacritic_score: null };
  return { rating: Number((n / 20).toFixed(2)), metacritic_score: Math.round(n) };
}

function bestTitle(a) {
  if (!a) return 'Untitled';
  if (a.canonicalTitle) return a.canonicalTitle;
  const t = a.titles || {};
  return t.en || t.en_jp || t.ja_jp || Object.values(t)[0] || 'Untitled';
}

/**
 * Normalize a Kitsu anime resource into the shared MediaListory media shape.
 * @param item JSON:API resource ({ id, attributes, relationships })
 * @param categoriesById optional map of category id -> { title } for genres
 */
function normalizeKitsuAnime(item, categoriesById) {
  if (!item || !item.id) return null;
  const a = item.attributes || {};
  const { rating, metacritic_score } = ratingFromKitsu(a.averageRating);

  let genres = [];
  const rel = item.relationships && item.relationships.categories && item.relationships.categories.data;
  if (Array.isArray(rel) && categoriesById) {
    genres = rel
      .map((r) => categoriesById[r.id])
      .filter(Boolean)
      .map((c) => ({ id: null, name: c.title }))
      .filter((g) => g.name);
  }

  return {
    id: externalRef('anime', item.id),
    media_type: 'anime',
    provider: 'kitsu',
    provider_id: String(item.id),
    name: bestTitle(a),
    background_image: pickImage(a.posterImage),
    backdrop_image: pickImage(a.coverImage) || pickImage(a.posterImage),
    description: a.synopsis || '',
    released: a.startDate || null,
    rating,
    metacritic_score,
    number_of_episodes: a.episodeCount != null ? a.episodeCount : null,
    episode_length: a.episodeLength != null ? a.episodeLength : null, // minutes/episode
    subtype: a.subtype || null,      // TV | movie | OVA | ONA | special | music
    status: a.status || null,        // finished | current | upcoming | ...
    age_rating: a.ageRating || null, // G | PG | R | R18
    ended: a.endDate || null,
    trailer: a.youtubeVideoId ? { key: a.youtubeVideoId } : null,
    genres,
    cast: [],
    developers: [],
    publishers: []
  };
}

/** Build an { id: {title, slug} } map from a JSON:API `included` array. */
function categoriesFromIncluded(included) {
  const map = {};
  (Array.isArray(included) ? included : []).forEach((r) => {
    if (r && r.type === 'categories' && r.id) {
      map[r.id] = { title: (r.attributes && r.attributes.title) || '', slug: (r.attributes && r.attributes.slug) || '' };
    }
  });
  return map;
}

module.exports = { normalizeKitsuAnime, categoriesFromIncluded, ratingFromKitsu, bestTitle, pickImage };
