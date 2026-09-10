const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRelations, hasRelations } = require('../../Backend/relations');

const film = (id, name, released) => ({ id, name, released, image: null });

test('entries are ordered by release and labelled around the current one', () => {
  const out = buildRelations([
    film('tmdb_movie_3', 'The Dark Knight Rises', '2012-07-16'),
    film('tmdb_movie_1', 'Batman Begins', '2005-06-15'),
    film('tmdb_movie_2', 'The Dark Knight', '2008-07-16')
  ], 'tmdb_movie_2');

  assert.deepEqual(out.map(e => [e.name, e.relation]), [
    ['Batman Begins', 'earlier'],
    ['The Dark Knight', 'current'],
    ['The Dark Knight Rises', 'later']
  ]);
});

test('a provider that records real relations gets the real words', () => {
  // Kitsu says which entry follows which, so "prequel" and "sequel" are claims
  // we can actually back up. Release order alone is not.
  const out = buildRelations([
    film('kitsu_1', 'Attack on Titan', '2013-04-07'),
    film('kitsu_2', 'Attack on Titan Season 2', '2017-04-01')
  ], 'kitsu_2', { ordered: true, narrative: true });

  assert.deepEqual(out.map(e => e.relation), ['prequel', 'current']);
});

test('a chain that already has an order is not re-sorted by date', () => {
  // An entry with no release date sorts last by date, which would move it out
  // of a sequence the provider explicitly gave us.
  const out = buildRelations([
    film('a', 'First', '2019-01-01'),
    film('b', 'Second', null),
    film('c', 'Third', '2023-01-01')
  ], 'a', { ordered: true, narrative: true });

  assert.deepEqual(out.map(e => e.name), ['First', 'Second', 'Third']);
});

test('nothing is shown when the current title is not in the list', () => {
  // Without knowing where it sits, "before" and "after" mean nothing, and a
  // list missing the thing you are looking at is worse than no list.
  assert.deepEqual(buildRelations([
    film('x', 'Something', '2000-01-01'),
    film('y', 'Something Else', '2001-01-01')
  ], 'not_here'), []);
});

test('a franchise of one is not a franchise', () => {
  assert.deepEqual(buildRelations([film('only', 'Alone', '2020-01-01')], 'only'), []);
});

test('duplicate entries are shown once', () => {
  const out = buildRelations([
    film('a', 'One', '2001-01-01'),
    film('a', 'One', '2001-01-01'),
    film('b', 'Two', '2002-01-01')
  ], 'a');
  assert.equal(out.length, 2);
});

test('a list of only the current title says nothing', () => {
  assert.equal(hasRelations([{ id: 'a', relation: 'current' }]), false);
  assert.equal(hasRelations([{ id: 'a', relation: 'current' }, { id: 'b', relation: 'later' }]), true);
  assert.equal(hasRelations([]), false);
});

test('a long run is trimmed around the entry being viewed', () => {
  // A strip of twenty is a strip nobody reads. What matters is what sits either
  // side of the one you are looking at, so the current entry stays centred.
  const many = Array.from({ length: 20 }, (_, i) =>
    film('g' + i, 'Game ' + i, '20' + String(10 + i).slice(-2) + '-01-01'));
  const out = buildRelations(many, 'g10', { reach: 3 });

  assert.deepEqual(out.map(e => e.name), [
    'Game 7', 'Game 8', 'Game 9', 'Game 10', 'Game 11', 'Game 12', 'Game 13'
  ]);
  assert.equal(out.find(e => e.relation === 'current').name, 'Game 10');
});

test('trimming does not drop the current entry at the start of a run', () => {
  const many = Array.from({ length: 8 }, (_, i) => film('g' + i, 'Game ' + i, '201' + i + '-01-01'));
  const out = buildRelations(many, 'g0', { reach: 2 });
  assert.equal(out[0].relation, 'current');
  assert.equal(out.length, 3);
});
