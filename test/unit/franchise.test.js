const { test } = require('node:test');
const assert = require('node:assert/strict');
const { franchiseOf, franchiseKey, collapseFranchises, membersToSeasons } = require('../../Backend/franchise');

const item = (name, released, eps = 12, subtype = 'TV') =>
  ({ id: 'kitsu_' + name.length + released, name, released, number_of_episodes: eps, subtype });

test('a season marker strips back to the parent title', () => {
  for (const [child, parent] of [
    ['Attack on Titan Season 2', 'Attack on Titan'],
    ['Attack on Titan: The Final Season', 'Attack on Titan'],
    ['Attack on Titan: The Final Season Part 2', 'Attack on Titan'],
    ['Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2', 'Re:Zero kara Hajimeru Isekai Seikatsu'],
    ['Mob Psycho 100 II', 'Mob Psycho 100'],
    ['One Punch Man 2', 'One Punch Man'],
    ['Vinland Saga Season 2', 'Vinland Saga']
  ]) {
    assert.equal(franchiseKey(child), franchiseKey(parent), `${child} should belong to ${parent}`);
    assert.equal(franchiseOf(child).isSequel, true);
  }
});

test('titles that merely look alike are left alone', () => {
  // The whole risk of a title heuristic is over-merging. None of these carry a
  // season marker, so none of them may be folded into anything.
  for (const name of [
    'Fate/Zero', 'Fate/stay night', 'Steins;Gate 0', 'Mob Psycho 100', '86',
    'Attack on Titan: Junior High', 'Attack on Titan: No Regrets',
    'Demon Slayer: Kimetsu no Yaiba Entertainment District Arc'
  ]) {
    assert.equal(franchiseOf(name).isSequel, false, `${name} must not read as a sequel`);
  }
  assert.notEqual(franchiseKey('Fate/Zero'), franchiseKey('Fate/stay night'));
  assert.notEqual(franchiseKey('Attack on Titan'), franchiseKey('Attack on Titan: Junior High'));
});

test('a trailing number is only a season number when it is season-sized', () => {
  // "Steins;Gate 0" and "Mob Psycho 100" end in digits that are part of the
  // name. Only 2..9 is treated as a sequel number.
  assert.equal(franchiseOf('Steins;Gate 0').isSequel, false);
  assert.equal(franchiseOf('Mob Psycho 100').isSequel, false);
  assert.equal(franchiseOf('Psycho-Pass 3').isSequel, true);
});

test('sequels collapse into the parent that is actually in the list', () => {
  const out = collapseFranchises([
    item('Attack on Titan', '2013-04-07'),
    item('Attack on Titan Season 2', '2017-04-01'),
    item('Attack on Titan: The Final Season', '2020-12-07'),
    item('Fate/Zero', '2011-10-02')
  ]);
  assert.deepEqual(out.map(m => m.name), ['Attack on Titan', 'Fate/Zero']);
  assert.equal(out[0].franchise_count, 3);
  assert.equal(out[1].franchise_count, undefined, 'a lone title is not a franchise');
});

test('a sequel with no parent in the list is shown rather than hidden', () => {
  // Being wrong here costs the user a title they searched for, so an orphan is
  // always displayed as itself.
  const out = collapseFranchises([item('Attack on Titan Season 3', '2018-07-23')]);
  assert.deepEqual(out.map(m => m.name), ['Attack on Titan Season 3']);
});

test('a genuine duplicate title is not folded away', () => {
  // Kitsu carries the TV cut and the movie cut of Mugen Train under the same
  // canonical title. Neither reads as a sequel, so both must survive.
  const out = collapseFranchises([
    item('Kimetsu no Yaiba: Mugen Ressha-hen', '2021-10-10'),
    item('Kimetsu no Yaiba: Mugen Ressha-hen', '2020-10-16')
  ]);
  assert.equal(out.length, 2);
});

test('the parent keeps its place when a sequel outranks it', () => {
  // Provider sort order is preserved, and the count lands on the parent even
  // though the sequel came first in the list.
  const out = collapseFranchises([
    item('Jujutsu Kaisen', '2020-10-03'),
    item('Attack on Titan Season 2', '2017-04-01'),
    item('Attack on Titan', '2013-04-07')
  ]);
  assert.deepEqual(out.map(m => m.name), ['Jujutsu Kaisen', 'Attack on Titan']);
  assert.equal(out[1].franchise_count, 2);
});

test('a franchise already shown on an earlier page is not repeated', () => {
  const seen = new Set();
  collapseFranchises([item('Attack on Titan', '2013-04-07')], { seen });
  const page2 = collapseFranchises([
    item('Attack on Titan', '2013-04-07'),
    item('Death Note', '2006-10-04')
  ], { seen });
  assert.deepEqual(page2.map(m => m.name), ['Death Note']);
});

test('members become seasons numbered by air date', () => {
  const seasons = membersToSeasons('Attack on Titan', [
    item('Attack on Titan Season 3', '2018-07-23'),
    item('Attack on Titan', '2013-04-07', 25),
    item('Attack on Titan Season 2', '2017-04-01'),
    item('Attack on Titan: Junior High', '2015-10-04')
  ]);
  assert.deepEqual(seasons.map(s => [s.season_number, s.episode_count]), [[1, 25], [2, 12], [3, 12]]);
  assert.equal(seasons.some(s => /Junior High/.test(s.name)), false, 'a spinoff is not a season');
});

test('extras are neither numbered as seasons nor counted on the tile', () => {
  // A franchise search drags in recaps, one minute shorts and compilation
  // movies. The number on the tile has to be the number the season list will
  // show, or the two surfaces disagree about the same show.
  const members = [
    item('Vinland Saga', '2019-07-08', 24),
    item('Vinland Saga Season 2', '2023-01-09', 24),
    item('Vinland Saga Season 2: Drowning in the Shadow', '2023-02-14', 1, 'ONA'),
    item('Vinland Saga Season 2 Recap', '2023-03-01', 4, 'special')
  ];
  assert.equal(membersToSeasons('Vinland Saga', members).length, 2);

  const out = collapseFranchises(members.slice());
  assert.equal(out.length, 1);
  assert.equal(out[0].franchise_count, 2, 'the tile counts seasons, not extras');
});

test('a tile says nothing when only one real season was found', () => {
  // The specials fold into the parent tile, but they are not a second season,
  // so the tile stays silent rather than claiming "2 seasons".
  const out = collapseFranchises([
    item('One Punch Man', '2015-10-05'),
    item('One Punch Man 2nd Season Specials', '2019-07-24', 6, 'special')
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].franchise_count, undefined);
});
