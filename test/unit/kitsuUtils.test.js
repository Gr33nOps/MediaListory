const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeKitsuAnime, categoriesFromIncluded, ratingFromKitsu, bestTitle } = require('../../Backend/kitsuUtils');
const { mediaToRow } = require('../../Backend/tmdbUtils');

test('ratingFromKitsu converts 0-100 to 0-5 + score', () => {
  assert.deepEqual(ratingFromKitsu('82.5'), { rating: 4.13, metacritic_score: 83 });
  assert.deepEqual(ratingFromKitsu(null), { rating: null, metacritic_score: null });
  assert.deepEqual(ratingFromKitsu('0'), { rating: null, metacritic_score: null });
});

test('bestTitle prefers canonical then english', () => {
  assert.equal(bestTitle({ canonicalTitle: 'Attack on Titan' }), 'Attack on Titan');
  assert.equal(bestTitle({ titles: { en: 'X', ja_jp: 'Y' } }), 'X');
  assert.equal(bestTitle({}), 'Untitled');
});

test('normalizeKitsuAnime maps to shared media shape', () => {
  const included = [{ type: 'categories', id: '1', attributes: { title: 'Action', slug: 'action' } }];
  const cats = categoriesFromIncluded(included);
  const anime = normalizeKitsuAnime({
    id: '7442',
    attributes: {
      canonicalTitle: 'Attack on Titan', synopsis: 'Humanity vs titans',
      posterImage: { large: 'https://x/p.jpg' }, coverImage: { large: 'https://x/c.jpg' },
      averageRating: '84.5', startDate: '2013-04-07', episodeCount: 25, subtype: 'TV', status: 'finished'
    },
    relationships: { categories: { data: [{ type: 'categories', id: '1' }] } }
  }, cats);

  assert.equal(anime.id, 'kitsu_7442');
  assert.equal(anime.media_type, 'anime');
  assert.equal(anime.provider, 'kitsu');
  assert.equal(anime.provider_id, '7442');
  assert.equal(anime.name, 'Attack on Titan');
  assert.equal(anime.released, '2013-04-07');
  assert.equal(anime.number_of_episodes, 25);
  assert.equal(anime.subtype, 'TV');
  assert.deepEqual(anime.genres.map((g) => g.name), ['Action']);
  assert.equal(anime.metacritic_score, 85); // round(84.5)
  assert.ok(anime.rating > 4.1 && anime.rating < 4.3); // ~84.5/20
});

test('mediaToRow stores anime with provider + episode_count', () => {
  const anime = normalizeKitsuAnime({
    id: '7442', attributes: { canonicalTitle: 'AoT', episodeCount: 25, averageRating: '80' }
  }, {});
  const row = mediaToRow(anime);
  assert.equal(row.game_id, 'kitsu_7442');
  assert.equal(row.provider, 'kitsu');
  assert.equal(row.provider_id, '7442');
  assert.equal(row.media_type, 'anime');
  assert.equal(row.episode_count, 25);
  assert.equal(row.igdb_id, null);
  assert.equal(row.tmdb_id, null);
});
