const { test } = require('node:test');
const assert = require('node:assert/strict');
const taste = require('../../Backend/taste');

// Build a taste profile the way loadProfiles would, from a compact spec:
// [game_id, score, ...genres]
function profile(items, top = {}) {
  const parsed = items.map(([game_id, score, ...genres]) => ({ game_id, score, genres }));
  return { items: parsed, top, genres: taste.genreVector(parsed) };
}

function library(size, prefix = 'x') {
  return Array.from({ length: size }, (_, i) => [`${prefix}${i}`, 7, 'Drama']);
}

test('overlap is measured against the smaller library', () => {
  // Ten shared titles is everything a 10-title library has, whether the other
  // side holds 20 or 2000. Dividing by a union or a total would punish the
  // smaller library for being small.
  assert.equal(taste.overlapScore(10, 10, 20), 1);
  assert.equal(taste.overlapScore(10, 10, 2000), 1);
  assert.equal(taste.overlapScore(5, 10, 2000), 0.5);
  assert.equal(taste.overlapScore(0, 0, 10), null);
});

test('rating agreement rewards scoring things the same way', () => {
  const same = [[8, 8], [5, 5], [10, 10]];
  const close = [[8, 7], [5, 6], [10, 9]];
  const opposed = [[10, 1], [1, 10], [10, 1]];
  assert.equal(taste.ratingScore(same), 1);
  assert.ok(taste.ratingScore(close) > 0.85 && taste.ratingScore(close) < 1);
  assert.equal(taste.ratingScore(opposed), 0);
  // Two co-rated titles is not enough to say anything.
  assert.equal(taste.ratingScore([[8, 8], [5, 5]]), null);
  assert.equal(taste.ratingScore([]), null);
});

test('Top 10 agreement weights rank and rank proximity', () => {
  const identical = { a: 1, b: 2, c: 3 };
  assert.equal(taste.topScore(identical, identical), 1);

  // Sharing a number one is worth more than sharing a number ten.
  const highMatch = taste.topScore({ a: 1 }, { a: 1 });
  const lowMatch = taste.topScore({ a: 10 }, { a: 10 });
  assert.ok(highMatch > lowMatch, `${highMatch} should beat ${lowMatch}`);

  // The same title ranked far apart counts for less than ranked together.
  const together = taste.topScore({ a: 1, b: 2 }, { a: 1, b: 2 });
  const apart = taste.topScore({ a: 1, b: 2 }, { a: 2, b: 1 });
  assert.ok(together > apart, `${together} should beat ${apart}`);

  assert.equal(taste.topScore({}, { a: 1 }), null);
  assert.equal(taste.topScore({ a: 1 }, { b: 1 }), 0);
});

test('a short Top 10 can still match perfectly', () => {
  // Three picks that are the other person's top three is a perfect match on this
  // component. Normalising against ten would cap them at 30% for no reason.
  assert.equal(taste.topScore({ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 3, d: 4, e: 5 }), 1);
});

test('genre affinity is weighted by how highly things were scored', () => {
  const lovesHorror = taste.genreVector([
    { score: 10, genres: ['Horror'] },
    { score: 2, genres: ['Comedy'] }
  ]);
  const alsoLovesHorror = taste.genreVector([{ score: 9, genres: ['Horror'] }]);
  const lovesComedy = taste.genreVector([{ score: 10, genres: ['Comedy'] }]);
  assert.ok(taste.genreScore(lovesHorror, alsoLovesHorror) > taste.genreScore(lovesHorror, lovesComedy));
  assert.equal(taste.genreScore({ Horror: 1 }, { Comedy: 1 }), 0);
  assert.equal(taste.genreScore({}, { Horror: 1 }), null);
});

test('too little to go on returns null rather than a number', () => {
  const tiny = profile([['a', 8, 'Drama'], ['b', 7, 'Drama']]);
  const big = profile(library(30));
  // Under the minimum library size on one side.
  assert.equal(taste.similarity(tiny, big), null);

  // Big enough libraries, but nothing at all in common.
  const mine = profile(library(20, 'mine'));
  const yours = profile(library(20, 'yours'));
  assert.equal(taste.similarity(mine, yours), null);
});

test('one shared Top 10 pick is enough to score, bare overlap alone is not', () => {
  const a = profile(library(20, 'a').concat([['shared', 9, 'Drama']]), { shared: 1 });
  const b = profile(library(20, 'b').concat([['shared', 9, 'Drama']]), { shared: 1 });
  assert.notEqual(taste.similarity(a, b), null);

  // The same single shared title with no Top 10 behind it is below the bar.
  const c = profile(library(20, 'a').concat([['shared', 9, 'Drama']]));
  const d = profile(library(20, 'b').concat([['shared', 9, 'Drama']]));
  assert.equal(taste.similarity(c, d), null);
});

test('Top 10 and matching scores outweigh merely having the same titles', () => {
  const shared = [['s1', null, 'Drama'], ['s2', null, 'Drama'], ['s3', null, 'Drama'],
                  ['s4', null, 'Drama'], ['s5', null, 'Drama']];
  const rest = library(10, 'pad');

  // Pair one: the same five titles saved, nothing ranked, nothing rated.
  const savedOnlyA = profile(shared.concat(rest));
  const savedOnlyB = profile(shared.concat(rest));

  // Pair two: the same five titles, both rated the same, and ranked the same.
  const ranked = { s1: 1, s2: 2, s3: 3 };
  const rated = shared.map(([id, , g]) => [id, 9, g]);
  const investedA = profile(rated.concat(rest), ranked);
  const investedB = profile(rated.concat(rest), ranked);

  const casual = taste.similarity(savedOnlyA, savedOnlyB);
  const invested = taste.similarity(investedA, investedB);
  assert.ok(casual && invested);
  assert.ok(invested.percent > casual.percent,
    `ranked and rated (${invested.percent}%) should beat saved only (${casual.percent}%)`);
});

test('disagreeing on scores pulls a pair apart', () => {
  const titles = ['s1', 's2', 's3', 's4', 's5'];
  const pad = library(10, 'pad');
  const agree = taste.similarity(
    profile(titles.map(t => [t, 9, 'Drama']).concat(pad)),
    profile(titles.map(t => [t, 9, 'Drama']).concat(pad))
  );
  const disagree = taste.similarity(
    profile(titles.map(t => [t, 10, 'Drama']).concat(pad)),
    profile(titles.map(t => [t, 1, 'Drama']).concat(pad))
  );
  assert.ok(agree.percent > disagree.percent,
    `agreeing (${agree.percent}%) should beat disagreeing (${disagree.percent}%)`);
});

test('a small library is not punished for being small', () => {
  // Everything the smaller person has, the larger person also has, rated the
  // same. That is a strong match regardless of the 15x size difference.
  const common = Array.from({ length: 12 }, (_, i) => [`c${i}`, 8, 'Drama']);
  const small = profile(common);
  const huge = profile(common.concat(library(180, 'extra')));
  const score = taste.similarity(small, huge);
  assert.ok(score && score.percent >= 70, `expected a strong match, got ${score && score.percent}`);
});

test('a percentage always lands in range and reports what it was built on', () => {
  const common = Array.from({ length: 10 }, (_, i) => [`c${i}`, 7, 'Drama']);
  const s = taste.similarity(profile(common), profile(common));
  assert.ok(s.percent >= 1 && s.percent <= 100);
  assert.equal(s.shared, 10);
  assert.equal(s.coRated, 10);
});

test('scoring is symmetric', () => {
  const a = profile(library(15, 'a').concat([['s1', 9, 'Drama'], ['s2', 6, 'Horror']]), { s1: 1 });
  const b = profile(library(15, 'b').concat([['s1', 8, 'Drama'], ['s2', 7, 'Horror']]), { s1: 2 });
  assert.equal(taste.similarity(a, b).percent, taste.similarity(b, a).percent);
});

test('genres survive the shapes Postgres hands back', () => {
  assert.deepEqual(taste.parseGenres([{ id: 1, name: 'Drama' }, { name: 'Horror' }]), ['Drama', 'Horror']);
  assert.deepEqual(taste.parseGenres('[{"name":"Action"}]'), ['Action']);
  assert.deepEqual(taste.parseGenres('not json'), []);
  assert.deepEqual(taste.parseGenres(null), []);
  assert.deepEqual(taste.parseGenres([{ id: 3 }]), []);
});

test('cache tells a miss apart from a stored null', () => {
  taste.cacheSet('pair:unit-test', null);
  assert.equal(taste.cacheGet('pair:unit-test'), null, 'a stored null reads back as null');
  assert.equal(taste.cacheGet('pair:never-set'), undefined, 'a miss reads back as undefined');
  taste.invalidate('unit-test');
  assert.equal(taste.cacheGet('pair:unit-test'), undefined, 'invalidate drops entries naming the user');
});

test('a profile can be narrowed to one category', () => {
  const items = [
    { game_id: 'm1', score: 9, media_type: 'movie', genres: ['Drama'] },
    { game_id: 'm2', score: 8, media_type: 'movie', genres: ['Drama'] },
    { game_id: 'g1', score: 3, media_type: 'game', genres: ['Shooter'] }
  ];
  const full = { items, top: { m1: 1, g1: 2 }, topTypes: { m1: 'movie', g1: 'game' }, genres: taste.genreVector(items) };

  const movies = taste.forMediaType(full, 'movie');
  assert.deepEqual(movies.items.map(i => i.game_id), ['m1', 'm2']);
  assert.deepEqual(movies.top, { m1: 1 }, 'a game must not appear in the movie Top 10');

  const games = taste.forMediaType(full, 'game');
  assert.deepEqual(games.items.map(i => i.game_id), ['g1']);
  assert.deepEqual(games.top, { g1: 2 });

  // Genres are recomputed from the subset. Using the whole-library vector would
  // drag every category towards whatever the person watches most of.
  assert.deepEqual(Object.keys(movies.genres), ['Drama']);
  assert.deepEqual(Object.keys(games.genres), ['Shooter']);
  assert.deepEqual(taste.forMediaType(full, 'anime').items, []);
});

test('category scores are independent of each other', () => {
  // Identical on movies, opposed on games. Comparing per category has to show
  // that split rather than averaging it away.
  const mk = (gameScore) => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ game_id: 'm' + i, score: 9, media_type: 'movie', genres: ['Drama'] })),
      ...Array.from({ length: 6 }, (_, i) => ({ game_id: 'g' + i, score: gameScore, media_type: 'game', genres: ['Shooter'] }))
    ];
    return { items, top: {}, topTypes: {}, genres: taste.genreVector(items) };
  };
  const a = mk(10), b = mk(1);
  const movies = taste.similarity(taste.forMediaType(a, 'movie'), taste.forMediaType(b, 'movie'));
  const games = taste.similarity(taste.forMediaType(a, 'game'), taste.forMediaType(b, 'game'));
  assert.ok(movies.percent > games.percent,
    `movies (${movies.percent}%) should beat games (${games.percent}%)`);
});
