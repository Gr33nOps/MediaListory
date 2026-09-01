/** Pure helpers for IGDB mapping / query building (unit-tested). */

function sanitizeToken(value, maxLen) {
  if (value == null) return '';
  return String(value)
    .replace(/["\\\n\r;]/g, '')
    .trim()
    .slice(0, maxLen || 80);
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function slugify(name) {
  return String(name || 'game')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200) || 'game';
}

function coverUrl(game, size) {
  if (!game?.cover?.url) return null;
  return 'https:' + game.cover.url.replace('t_thumb', size || 't_cover_big');
}

function mapIgdbToRow(game) {
  const publishers = [];
  const developers = [];
  (game.involved_companies || []).forEach(ic => {
    if (!ic.company) return;
    if (ic.publisher) publishers.push({ name: ic.company.name });
    if (ic.developer) developers.push({ name: ic.company.name });
  });

  let rating = null;
  let metacritic = null;
  if (game.total_rating && game.total_rating_count >= 5) {
    rating = Number((game.total_rating / 20).toFixed(2));
    metacritic = Math.round(game.total_rating);
  } else if (game.aggregated_rating && game.aggregated_rating_count >= 3) {
    rating = Number((game.aggregated_rating / 20).toFixed(2));
    metacritic = Math.round(game.aggregated_rating);
  }

  return {
    game_id: `igdb_${game.id}`,
    igdb_id: game.id,
    media_type: 'game',
    provider: 'igdb',
    provider_id: String(game.id),
    name: game.name,
    slug: slugify(game.name),
    description: game.summary || null,
    background_image: coverUrl(game),
    rating,
    metacritic_score: metacritic,
    released: game.first_release_date
      ? new Date(game.first_release_date * 1000).toISOString().slice(0, 10)
      : null,
    playtime: 0,
    genres: JSON.stringify(game.genres || []),
    platforms: JSON.stringify(game.platforms || []),
    publishers: JSON.stringify(publishers),
    developers: JSON.stringify(developers)
  };
}

function parseIgdbClientId(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  const m = s.match(/^igdb_(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(s, 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

function toClientGameId(igdbId) {
  return `igdb_${igdbId}`;
}

module.exports = {
  sanitizeToken,
  clampInt,
  slugify,
  coverUrl,
  mapIgdbToRow,
  parseIgdbClientId,
  toClientGameId
};
