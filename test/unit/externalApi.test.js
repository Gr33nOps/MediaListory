const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { lookup, singleFlight, createLimiter, sourceEnabled, cache } =
  require(path.join(__dirname, '..', '..', 'Backend', 'externalApi'));

test('concurrent lookups of one key make a single upstream call', async () => {
  cache.clear();
  let calls = 0;
  const slow = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return { value: 'once' };
  };

  const results = await Promise.all(
    Array.from({ length: 8 }, () => lookup('sf:test', 60_000, slow))
  );

  assert.strictEqual(calls, 1, 'upstream should be hit exactly once');
  results.forEach((r) => assert.deepStrictEqual(r, { value: 'once' }));
});

test('a resolved value is served from cache on the next call', async () => {
  cache.clear();
  let calls = 0;
  const fn = async () => { calls++; return 'v'; };

  assert.strictEqual(await lookup('hit:test', 60_000, fn), 'v');
  assert.strictEqual(await lookup('hit:test', 60_000, fn), 'v');
  assert.strictEqual(calls, 1);
});

test('a null result is cached too, so a known absence is not re-fetched', async () => {
  cache.clear();
  let calls = 0;
  const missing = async () => { calls++; return null; };

  assert.strictEqual(await lookup('neg:test', 60_000, missing), null);
  assert.strictEqual(await lookup('neg:test', 60_000, missing), null);
  assert.strictEqual(calls, 1, 'a confirmed absence should not be looked up twice');
});

test('a thrown error resolves to null and is NOT cached', async () => {
  cache.clear();
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('upstream down');
    return 'recovered';
  };

  assert.strictEqual(await lookup('err:test', 60_000, flaky), null,
    'a failure must never reject into the route');
  assert.strictEqual(await lookup('err:test', 60_000, flaky), 'recovered',
    'a transient failure must not poison the cache');
});

test('singleFlight releases the key once settled', async () => {
  let calls = 0;
  const fn = async () => { calls++; return calls; };

  assert.strictEqual(await singleFlight('k', fn), 1);
  assert.strictEqual(await singleFlight('k', fn), 2,
    'a completed flight should not keep de-duplicating later calls');
});

test('the limiter spaces successive calls', async () => {
  const schedule = createLimiter(40);
  const stamps = [];
  await Promise.all([1, 2, 3].map(() => schedule(async () => { stamps.push(Date.now()); })));

  stamps.sort((a, b) => a - b);
  assert.ok(stamps[2] - stamps[0] >= 70,
    `three calls at 40ms spacing should span >=70ms, saw ${stamps[2] - stamps[0]}ms`);
});

test('the limiter keeps running after a rejected call', async () => {
  const schedule = createLimiter(5);
  await assert.rejects(() => schedule(async () => { throw new Error('boom'); }));
  assert.strictEqual(await schedule(async () => 'still here'), 'still here');
});

test('sources are on unless explicitly set to 0', () => {
  delete process.env.TEST_SOURCE_FLAG;
  assert.strictEqual(sourceEnabled('TEST_SOURCE_FLAG'), true);
  process.env.TEST_SOURCE_FLAG = '1';
  assert.strictEqual(sourceEnabled('TEST_SOURCE_FLAG'), true);
  process.env.TEST_SOURCE_FLAG = '0';
  assert.strictEqual(sourceEnabled('TEST_SOURCE_FLAG'), false);
  delete process.env.TEST_SOURCE_FLAG;
});
