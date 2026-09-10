/**
 * Shared plumbing for the secondary ("enrichment") data sources.
 *
 * These sources are all optional: they add price, score, theme and episode
 * detail on top of the IGDB/TMDB/Kitsu core. Nothing here may ever throw into a
 * request handler, and nothing here may ever be the reason a detail page fails
 * to render - hence every public helper resolves to null instead of rejecting.
 *
 * On top of the plain TTL cache the core proxies use, this adds the two things
 * a fan-out to third-party APIs actually needs:
 *
 *   - single-flight, so ten people opening the same title make one upstream
 *     call rather than ten;
 *   - negative caching, so a game with no Steam release is not re-resolved on
 *     every single view.
 */

const fetch = require('node-fetch');
const { createTtlCache } = require('./cache');

// One cache for every source. Keys are namespaced by caller (e.g. "mal:1").
const cache = createTtlCache();
const inflight = new Map();

// Misses are cheap to re-check but not free; a shorter TTL keeps a title that
// genuinely has no deal/theme/episode from hammering the source all day.
const NEGATIVE_TTL_MS = 30 * 60 * 1000;

// Identifies us to the sources that ask for it. CheapShark rejects requests
// without a User-Agent outright.
const USER_AGENT = 'MediaListory/1.0 (+https://medialistory.vercel.app)';

/**
 * Run `fn` once per key even when called concurrently. Callers that arrive
 * while a call is in flight await the same promise.
 */
function singleFlight(key, fn) {
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

/**
 * Cached + de-duplicated lookup. `fn` should resolve to the value, or null when
 * the source genuinely has nothing. Both outcomes are cached; failures are not,
 * so a transient outage does not poison the cache for the full TTL.
 */
function lookup(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit === '__null__' ? null : hit);

  return singleFlight(key, async () => {
    // Re-check inside the flight: an earlier caller may have just filled it.
    const raced = cache.get(key);
    if (raced !== undefined) return raced === '__null__' ? null : raced;

    try {
      const value = await fn();
      cache.set(key, value == null ? '__null__' : value, value == null ? NEGATIVE_TTL_MS : ttlMs);
      return value == null ? null : value;
    } catch (_) {
      // Deliberately not cached - the next viewer should get a fresh attempt.
      return null;
    }
  });
}

/**
 * Per-host request spacing. The core proxies each keep their own `lastAPICall`
 * timestamp; this is the same idea, but keyed by host so one slow source cannot
 * delay another, and queued so bursts are spaced rather than dropped.
 */
function createLimiter(minIntervalMs) {
  let tail = Promise.resolve();
  let last = 0;

  return function schedule(fn) {
    const run = tail.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    // Keep the chain alive even when a call rejects.
    tail = run.then(() => {}, () => {});
    return run;
  };
}

// Comfortably inside each source's published limit.
const limiters = {
  'api.jikan.moe':          createLimiter(500),  // published ~3/s; we use 2/s
  'api.animethemes.moe':    createLimiter(400),
  'api.tvmaze.com':         createLimiter(700),  // published 20 per 10s
  'www.cheapshark.com':     createLimiter(1000), // on-demand only, no crawling
  'kitsu.io':               createLimiter(300)
};

function limiterFor(url) {
  try {
    return limiters[new URL(url).host] || null;
  } catch (_) {
    return null;
  }
}

/**
 * GET JSON with a hard timeout.
 *
 * By default it resolves to null on any failure, so callers never need a
 * try/catch. Pass `strict: true` when the answer is going to be cached: then
 * only a 404 means "not there" (null) and everything else - timeout, network
 * error, 429, 5xx, bad JSON - throws. The difference matters, because `lookup`
 * caches a null as a confirmed absence but never caches a throw. Without it, a
 * single slow reply from Kitsu hid an anime's MyAnimeList score for the whole
 * negative-cache window.
 */
async function fetchJson(url, options = {}) {
  const { timeoutMs = 4000, accept = 'application/json', strict = false } = options;

  const fail = (reason) => {
    if (strict) throw new Error(reason);
    return null;
  };

  const run = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetch(url, {
          headers: { Accept: accept, 'User-Agent': USER_AGENT },
          signal: controller.signal
        });
      } catch (err) {
        return fail('request failed: ' + (err && err.message));
      }

      if (res.status === 429) {
        // Back off for the rest of this request rather than retrying in a loop;
        // the caller simply renders without this source.
        if (process.env.NODE_ENV !== 'production') {
          console.warn('Enrichment rate-limited:', url, 'retry-after:', res.headers.get('retry-after'));
        }
        return fail('rate limited');
      }
      if (res.status === 404) return null;
      if (!res.ok) return fail('upstream ' + res.status);
      try {
        return await res.json();
      } catch (_) {
        return fail('bad json');
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const limiter = limiterFor(url);
  return limiter ? limiter(run) : run();
}

/** Read an env flag that defaults to on. Set to "0" to disable a source. */
function sourceEnabled(name) {
  return process.env[name] !== '0';
}

module.exports = {
  cache,
  lookup,
  singleFlight,
  fetchJson,
  createLimiter,
  sourceEnabled,
  USER_AGENT,
  NEGATIVE_TTL_MS
};
