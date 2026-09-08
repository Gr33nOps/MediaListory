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

// Normalize a title/query for comparison: lowercase, strip accents, collapse
// punctuation/whitespace. "Pokémon: Red!" and "pokemon red" become equal.
function normalizeForSearch(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Re-rank an already-fetched list so obvious title matches surface first,
// WITHOUT dropping anything (never filters). Ties keep the API's own order,
// so this only promotes exact/prefix/word hits over the provider's relevance
// ranking — it never replaces good API results with worse local guesses.
function rankSearchResults(items, term, getName) {
  // Ignore a leading article so "dark knight" still matches "The Dark Knight".
  const dropArticle = (s) => s.replace(/^(the|an|a) /, '') || s;
  const q = dropArticle(normalizeForSearch(term));
  if (!q || !Array.isArray(items) || items.length < 2) return items;
  const scored = items.map((item, i) => {
    const name = dropArticle(normalizeForSearch(typeof getName === 'function' ? getName(item) : item));
    let score;
    if (name === q) score = 0;                       // exact title
    else if (name.startsWith(q + ' ')) score = 1;    // title begins with the query
    else if (name.startsWith(q)) score = 2;          // prefix
    else if ((' ' + name + ' ').includes(' ' + q + ' ')) score = 3; // whole-word hit
    else if (name.includes(q)) score = 4;            // substring
    else score = 5;                                  // fuzzy/provider match
    return { item, score, i };
  });
  scored.sort((a, b) => (a.score - b.score) || (a.i - b.i));
  return scored.map((s) => s.item);
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
  normalizeForSearch,
  rankSearchResults,
  slugify,
  coverUrl,
  mapIgdbToRow,
  parseIgdbClientId,
  toClientGameId
};
