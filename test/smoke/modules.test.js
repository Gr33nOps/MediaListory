const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

test('required entry files exist with Linux casing', () => {
  const files = [
    'Backend/server.js',
    'Backend/auth.js',
    'Backend/igdb.js',
    'Backend/igdbUtils.js',
    'Backend/tmdb.js',
    'Backend/tmdbUtils.js',
    'Backend/kitsu.js',
    'Backend/kitsuUtils.js',
    'Backend/neonAuth.js',
    'Backend/myGameList.js',
    'Backend/localUser.js',
    'Backend/sessionCookies.js',
    'Frontend/index.html',
    'Frontend/home.html',
    'Frontend/movies.html',
    'Frontend/series.html',
    'Frontend/anime.html',
    'Frontend/media-browse.js',
    'Frontend/auth.html',
    'Frontend/admin.html',
    'Frontend/moderator.html',
    'Frontend/common.js',
    'DB/schema.postgres.sql',
    'docs/API.md',
    'docs/openapi.yaml',
    'docs/runbook.md'
  ];
  for (const rel of files) {
    assert.ok(fs.existsSync(path.join(root, rel)), missing(rel));
  }
  assert.ok(!fs.existsSync(path.join(root, 'Frontend/landing.js')), 'landing.js should be removed');
  assert.ok(!fs.existsSync(path.join(root, 'Frontend/landing.css')), 'landing.css should be removed');
  assert.ok(!fs.existsSync(path.join(root, 'Backend/publicShowcase.js')), 'publicShowcase.js should be removed');
});

test('backend factories export functions', () => {
  const mods = [
    './auth',
    './admin',
    './moderator',
    './myGameList',
    './igdb',
    './tmdb',
    './kitsu',
    './friends',
    './home',
    './profile',
    './userProfile'
  ];
  for (const m of mods) {
    const factory = require(path.join(root, 'Backend', m));
    assert.equal(typeof factory, 'function', m + ' should export a factory');
  }
});

test('ID contract helpers match docs', () => {
  const { parseIgdbClientId, toClientGameId } = require('../../Backend/igdbUtils');
  assert.equal(toClientGameId(1), 'igdb_1');
  assert.equal(parseIgdbClientId('igdb_1'), 1);
});

function missing(rel) {
  return 'missing ' + rel;
}
