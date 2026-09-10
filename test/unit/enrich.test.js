const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const buildEnrich = require(path.join(ROOT, 'Backend', 'enrich'));
const buildExternalIds = require(path.join(ROOT, 'Backend', 'externalIds'));
const { cache } = require(path.join(ROOT, 'Backend', 'externalApi'));

const pass = (req, res, next) => next();

/** Mount the enrichment router with whatever id resolvers a test wants. */
function serve(externalIds) {
  const app = express();
  app.use('/api/enrich', buildEnrich(pass, pass, { externalIds }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({
        server,
        get: async (p) => {
          const r = await fetch(`http://127.0.0.1:${port}${p}`);
          return { status: r.status, sources: r.headers.get('X-Enrich-Sources'), body: await r.json() };
        }
      });
    });
  });
}

test.beforeEach(() => cache.clear());

test('a non-numeric id is rejected before any upstream call', async () => {
  const { server, get } = await serve({});
  try {
    for (const p of ['/api/enrich/game/abc', '/api/enrich/anime/0', '/api/enrich/series/-1']) {
      assert.strictEqual((await get(p)).status, 400, p + ' should be a 400');
    }
  } finally { server.close(); }
});

test('an unresolvable id answers 200 with nulls, not an error', async () => {
  const { server, get } = await serve({
    steamAppId: async () => null,
    malId: async () => null,
    tvmazeId: async () => null
  });
  try {
    const game = await get('/api/enrich/game/233');
    assert.strictEqual(game.status, 200);
    assert.strictEqual(game.body.deal, null);
    assert.strictEqual(game.sources, 'none');

    const anime = await get('/api/enrich/anime/1');
    assert.strictEqual(anime.status, 200);
    assert.deepStrictEqual(anime.body, { mal: null, themes: null });

    const series = await get('/api/enrich/series/1396');
    assert.strictEqual(series.status, 200);
    assert.strictEqual(series.body.episodes, null);
  } finally { server.close(); }
});

test('a throwing id resolver still yields 200 - enrichment never breaks a page', async () => {
  const boom = async () => { throw new Error('upstream exploded'); };
  const { server, get } = await serve({ steamAppId: boom, malId: boom, tvmazeId: boom });
  try {
    for (const p of ['/api/enrich/game/233', '/api/enrich/anime/1', '/api/enrich/series/1396']) {
      const r = await get(p);
      assert.strictEqual(r.status, 200, p + ' must not surface an error status');
    }
  } finally { server.close(); }
});

test('a disabled source is skipped without calling out', async () => {
  process.env.ENRICH_ANIME = '0';
  let called = false;
  const { server, get } = await serve({ malId: async () => { called = true; return '1'; } });
  try {
    const r = await get('/api/enrich/anime/1');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { mal: null, themes: null });
    assert.strictEqual(called, false, 'a disabled source must not be queried');
  } finally {
    server.close();
    delete process.env.ENRICH_ANIME;
  }
});

test('the id resolver reads Steam appids out of a real IGDB external_games payload', async () => {
  // Shape copied from a live IGDB response for Half-Life 2 (game 233).
  const rows = [
    { id: 155609, game: 233, uid: '1539', external_game_source: 3 },   // Giant Bomb
    { id: 190217, game: 233, uid: 'UCYzliE_Hv', external_game_source: 10 }, // YouTube
    { id: 15164,  game: 233, uid: '220',  external_game_source: 1 },   // Steam
    { id: 245454, game: 233, uid: '1420', external_game_source: 14 }   // Twitch
  ];
  const ids = buildExternalIds({
    db: null,
    igdbFetch: async () => ({ ok: true, json: async () => rows })
  });
  assert.strictEqual(await ids.steamAppId(233), '220');
});

test('a game with no Steam row resolves to null rather than a wrong id', async () => {
  const ids = buildExternalIds({
    db: null,
    igdbFetch: async () => ({ ok: true, json: async () => [{ uid: 'abc', external_game_source: 3 }] })
  });
  assert.strictEqual(await ids.steamAppId(999999), null);
});

test('an IGDB failure resolves to null instead of throwing', async () => {
  const ids = buildExternalIds({
    db: null,
    igdbFetch: async () => ({ ok: false, status: 502, json: async () => ({}) })
  });
  assert.strictEqual(await ids.steamAppId(233), null);
});

test('a non-numeric Steam uid is rejected', async () => {
  const ids = buildExternalIds({
    db: null,
    igdbFetch: async () => ({ ok: true, json: async () => [{ uid: 'not-an-appid', external_game_source: 1 }] })
  });
  assert.strictEqual(await ids.steamAppId(233), null,
    'only a numeric appid is usable, anything else would send CheapShark garbage');
});

test('bad ids never reach the network', async () => {
  let called = false;
  const ids = buildExternalIds({ db: null, igdbFetch: async () => { called = true; return null; } });
  assert.strictEqual(await ids.steamAppId('abc'), null);
  assert.strictEqual(await ids.steamAppId(-5), null);
  assert.strictEqual(await ids.malId(0), null);
  assert.strictEqual(await ids.tvmazeId(null), null);
  assert.strictEqual(called, false);
});
