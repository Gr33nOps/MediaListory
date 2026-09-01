const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  externalRef,
  parseMediaRef,
  isValidMediaType,
  ratingFromVote,
  resolveGenres,
  normalizeTmdbMovie,
  normalizeTmdbSeries,
  normalizeTmdb,
  mediaToRow,
  tmdbEndpointFor,
  tmdbImage
} = require('../../Backend/tmdbUtils');

test('externalRef builds scheme per media type', () => {
  assert.equal(externalRef('movie', 27205), 'tmdb_movie_27205');
  assert.equal(externalRef('series', 1396), 'tmdb_series_1396');
  assert.equal(externalRef('anime', 7442), 'kitsu_7442');
  assert.equal(externalRef('game', 1942), 'igdb_1942');
  assert.equal(externalRef('movie', 0), null);
  assert.equal(externalRef('movie', 'abc'), null);
});

test('parseMediaRef round-trips every scheme (provider-safe, no collisions)', () => {
  assert.deepEqual(parseMediaRef('tmdb_movie_27205'), { media_type: 'movie', id: 27205 });
  assert.deepEqual(parseMediaRef('tmdb_series_1396'), { media_type: 'series', id: 1396 });
  assert.deepEqual(parseMediaRef('kitsu_7442'), { media_type: 'anime', id: 7442 });
  assert.deepEqual(parseMediaRef('igdb_1942'), { media_type: 'game', id: 1942 });
  assert.equal(parseMediaRef('nonsense'), null);
  assert.equal(parseMediaRef(''), null);
  // Same numeric id across providers never collides:
  assert.notEqual(externalRef('movie', 1), externalRef('game', 1));
  assert.notEqual(externalRef('anime', 1), externalRef('series', 1));
});

test('isValidMediaType includes anime', () => {
  assert.ok(isValidMediaType('game'));
  assert.ok(isValidMediaType('movie'));
  assert.ok(isValidMediaType('series'));
  assert.ok(isValidMediaType('anime'));
  assert.ok(!isValidMediaType('book'));
});

test('tmdbEndpointFor maps series to tv', () => {
  assert.equal(tmdbEndpointFor('movie'), 'movie');
  assert.equal(tmdbEndpointFor('series'), 'tv');
  assert.equal(tmdbEndpointFor('game'), null);
});

test('tmdbImage builds full url or null', () => {
  assert.equal(tmdbImage('/abc.jpg', 'w500'), 'https://image.tmdb.org/t/p/w500/abc.jpg');
  assert.equal(tmdbImage(null), null);
  assert.equal(tmdbImage(''), null);
  assert.equal(tmdbImage('https://x/y.jpg'), 'https://x/y.jpg');
});

test('ratingFromVote applies the vote-count threshold', () => {
  assert.deepEqual(ratingFromVote(8.4, 1200), { rating: 4.2, metacritic_score: 84 });
  assert.deepEqual(ratingFromVote(9, 2), { rating: null, metacritic_score: null }); // too few votes
  assert.deepEqual(ratingFromVote(0, 1000), { rating: null, metacritic_score: null });
});

test('resolveGenres uses genre_ids + map, or inline genres', () => {
  const map = { 28: 'Action', 878: 'Science Fiction' };
  assert.deepEqual(resolveGenres({ genre_ids: [28, 878, 999] }, map), [
    { id: 28, name: 'Action' },
    { id: 878, name: 'Science Fiction' }
  ]);
  assert.deepEqual(resolveGenres({ genres: [{ id: 18, name: 'Drama' }] }, map), [
    { id: 18, name: 'Drama' }
  ]);
});

test('normalizeTmdbMovie maps core fields', () => {
  const movie = normalizeTmdbMovie({
    id: 27205,
    title: 'Inception',
    overview: 'A thief...',
    poster_path: '/poster.jpg',
    backdrop_path: '/backdrop.jpg',
    release_date: '2010-07-16',
    vote_average: 8.4,
    vote_count: 34000,
    genre_ids: [28, 878],
    production_companies: [{ name: 'Legendary' }],
    credits: { crew: [{ job: 'Director', name: 'Christopher Nolan' }, { job: 'Writer', name: 'x' }] }
  }, { 28: 'Action', 878: 'Science Fiction' });

  assert.equal(movie.id, 'tmdb_movie_27205');
  assert.equal(movie.media_type, 'movie');
  assert.equal(movie.tmdb_id, 27205);
  assert.equal(movie.name, 'Inception');
  assert.equal(movie.released, '2010-07-16');
  assert.equal(movie.rating, 4.2);
  assert.equal(movie.metacritic_score, 84);
  assert.equal(movie.background_image, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.deepEqual(movie.genres.map(g => g.name), ['Action', 'Science Fiction']);
  assert.deepEqual(movie.developers, [{ name: 'Christopher Nolan' }]);
  assert.deepEqual(movie.publishers, [{ name: 'Legendary' }]);
});

test('normalizeTmdbSeries maps core fields', () => {
  const series = normalizeTmdbSeries({
    id: 1396,
    name: 'Breaking Bad',
    overview: 'A chemistry teacher...',
    poster_path: '/bb.jpg',
    first_air_date: '2008-01-20',
    vote_average: 8.9,
    vote_count: 12000,
    genres: [{ id: 18, name: 'Drama' }],
    created_by: [{ name: 'Vince Gilligan' }],
    networks: [{ name: 'AMC' }]
  });

  assert.equal(series.id, 'tmdb_series_1396');
  assert.equal(series.media_type, 'series');
  assert.equal(series.name, 'Breaking Bad');
  assert.equal(series.released, '2008-01-20');
  assert.deepEqual(series.genres.map(g => g.name), ['Drama']);
  assert.deepEqual(series.developers, [{ name: 'Vince Gilligan' }]);
  assert.deepEqual(series.publishers, [{ name: 'AMC' }]);
});

test('normalizeTmdb dispatches by media type', () => {
  assert.equal(normalizeTmdb('movie', { id: 1, title: 'X' }).media_type, 'movie');
  assert.equal(normalizeTmdb('series', { id: 1, name: 'Y' }).media_type, 'series');
  assert.equal(normalizeTmdb('game', { id: 1 }), null);
});

test('mediaToRow produces a games-table row for movies', () => {
  const media = normalizeTmdbMovie({
    id: 27205, title: 'Inception', release_date: '2010-07-16',
    vote_average: 8.4, vote_count: 34000, poster_path: '/p.jpg', genre_ids: [28]
  }, { 28: 'Action' });
  const row = mediaToRow(media);
  assert.equal(row.game_id, 'tmdb_movie_27205');
  assert.equal(row.media_type, 'movie');
  assert.equal(row.tmdb_id, 27205);
  assert.equal(row.igdb_id, null);
  assert.equal(row.name, 'Inception');
  assert.equal(typeof row.genres, 'string'); // JSON-stringified for JSONB column
  assert.deepEqual(JSON.parse(row.genres), [{ id: 28, name: 'Action' }]);
});
