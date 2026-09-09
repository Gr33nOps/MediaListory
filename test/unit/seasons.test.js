const { test } = require('node:test');
const assert = require('node:assert/strict');
const seasons = require('../../Backend/seasons');

const { deriveOverall, clampScore } = seasons;

test('an overall is only derived once a season is rated', () => {
  assert.equal(deriveOverall([]), null);
  assert.equal(deriveOverall(null), null);
  // Seasons tracked but not scored must not produce an overall, or simply
  // marking a season "watched" would silently invent a rating.
  assert.equal(deriveOverall([{ score: null, episode_count: 10, status: 'completed' }]), null);
});

test('seasons are weighted by episode count, not averaged flat', () => {
  // A 24 episode season scored 9 and a 4 episode special scored 3. A flat mean
  // says 6, which badly misrepresents a show someone mostly loved.
  const weighted = deriveOverall([
    { score: 9, episode_count: 24 },
    { score: 3, episode_count: 4 }
  ]);
  assert.equal(weighted, 8, `expected 8, got ${weighted}`);
});

test('only rated seasons count toward the overall', () => {
  // Two of five rated. The unrated three must not be treated as zeros.
  const score = deriveOverall([
    { score: 8, episode_count: 12 },
    { score: 8, episode_count: 12 },
    { score: null, episode_count: 12 },
    { score: null, episode_count: 12 },
    { score: null, episode_count: 12 }
  ]);
  assert.equal(score, 8);
});

test('a season with no episode count still counts', () => {
  // Providers do not always report an episode count. Weighting it at zero would
  // drop the user's rating on the floor.
  assert.equal(deriveOverall([{ score: 7, episode_count: null }]), 7);
  const mixed = deriveOverall([
    { score: 10, episode_count: null },
    { score: 10, episode_count: 20 }
  ]);
  assert.equal(mixed, 10);
});

test('the result is always a whole number in range', () => {
  // 8.5 rounds rather than surfacing a decimal: this app only has whole scores.
  const rounded = deriveOverall([
    { score: 8, episode_count: 10 },
    { score: 9, episode_count: 10 }
  ]);
  assert.equal(rounded, 9);
  assert.equal(Number.isInteger(rounded), true);

  for (const s of [deriveOverall([{ score: 1, episode_count: 5 }]), deriveOverall([{ score: 10, episode_count: 5 }])]) {
    assert.ok(s >= 1 && s <= 10);
  }
});

test('scores are clamped and coerced to whole numbers', () => {
  assert.equal(clampScore(7), 7);
  assert.equal(clampScore('8'), 8);
  assert.equal(clampScore(8.4), 8);
  assert.equal(clampScore(8.6), 9);
  assert.equal(clampScore(0), 1, 'below range clamps up rather than storing 0');
  assert.equal(clampScore(99), 10);
  assert.equal(clampScore('nonsense'), null);
  assert.equal(clampScore(null), null);
});

test('one weak season cannot drag a long run below what it deserves', () => {
  // Four strong 24 episode seasons and one weak 10 episode one:
  // (9*96 + 4*10) / 106 = 8.53, so the run still reads as a 9. A flat mean of
  // the five season scores would have said 8 and undersold it.
  const weighted = deriveOverall([
    { score: 9, episode_count: 24 },
    { score: 9, episode_count: 24 },
    { score: 9, episode_count: 24 },
    { score: 9, episode_count: 24 },
    { score: 4, episode_count: 10 }
  ]);
  assert.equal(weighted, 9, `expected 9, got ${weighted}`);

  const flatMean = Math.round((9 + 9 + 9 + 9 + 4) / 5);
  assert.equal(flatMean, 8, 'the unweighted answer would have been lower');
});
