const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');

const { fetchJson, cache } = require(path.join(__dirname, '..', '..', 'Backend', 'externalApi'));

/** Spin up a throwaway origin so upstream behaviour can be forced exactly. */
function origin(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test.beforeEach(() => cache.clear());

test('a 200 returns the parsed body', async () => {
  const { server, base } = await origin((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, n: 1 }));
  });
  try {
    assert.deepStrictEqual(await fetchJson(base + '/thing'), { ok: true, n: 1 });
  } finally { server.close(); }
});

test('a 429 resolves to null rather than throwing or retrying in a loop', async () => {
  let hits = 0;
  const { server, base } = await origin((req, res) => {
    hits++;
    res.writeHead(429, { 'Retry-After': '30' });
    res.end('slow down');
  });
  try {
    assert.strictEqual(await fetchJson(base + '/limited'), null);
    assert.strictEqual(hits, 1, 'a rate-limit response must not trigger a retry storm');
  } finally { server.close(); }
});

test('a 500 resolves to null', async () => {
  const { server, base } = await origin((req, res) => { res.writeHead(500); res.end('nope'); });
  try {
    assert.strictEqual(await fetchJson(base + '/broken'), null);
  } finally { server.close(); }
});

test('malformed JSON resolves to null instead of throwing', async () => {
  const { server, base } = await origin((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{ not json at all');
  });
  try {
    assert.strictEqual(await fetchJson(base + '/garbage'), null);
  } finally { server.close(); }
});

test('a hanging upstream is abandoned at the timeout, not left pending', async () => {
  const { server, base } = await origin(() => { /* never responds */ });
  try {
    const started = Date.now();
    const result = await fetchJson(base + '/hang', { timeoutMs: 150 });
    const elapsed = Date.now() - started;

    assert.strictEqual(result, null);
    assert.ok(elapsed < 1500, `should give up promptly, took ${elapsed}ms`);
  } finally {
    server.close();
    server.closeAllConnections && server.closeAllConnections();
  }
});

test('an unroutable host resolves to null', async () => {
  assert.strictEqual(
    await fetchJson('http://127.0.0.1:1/nothing-listening', { timeoutMs: 500 }),
    null
  );
});

// Strict mode is what the cached lookups use. The split between "not there"
// and "could not ask" is the whole point: only the first may be cached.
test('strict: a 404 is a genuine absence and resolves to null', async () => {
  const { server, base } = await origin((req, res) => { res.writeHead(404); res.end('no'); });
  try {
    assert.strictEqual(await fetchJson(base + '/missing', { strict: true }), null);
  } finally { server.close(); }
});

test('strict: a 5xx, 429 or bad JSON throws instead of looking like "none"', async () => {
  for (const [status, body] of [[503, 'down'], [429, 'slow'], [200, '{ nope']]) {
    const { server, base } = await origin((req, res) => { res.writeHead(status); res.end(body); });
    try {
      await assert.rejects(() => fetchJson(base + '/x', { strict: true }), `status ${status} should throw`);
    } finally { server.close(); }
  }
});

test('strict: a failed upstream is not cached, so the next call tries again', async () => {
  const { lookup } = require(path.join(__dirname, '..', '..', 'Backend', 'externalApi'));
  let hits = 0;
  const { server, base } = await origin((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(503); return res.end('blip'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 42 }));
  });
  try {
    const get = () => lookup('strict:retry', 60_000, () => fetchJson(base + '/flaky', { strict: true }));
    assert.strictEqual(await get(), null, 'the blip renders as nothing');
    assert.deepStrictEqual(await get(), { id: 42 }, 'but is not remembered as "none"');
    assert.strictEqual(hits, 2);
  } finally { server.close(); }
});
