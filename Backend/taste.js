/* Similar Taste.

   Scores how close two libraries are on four signals, weighted by how much each
   one actually says about taste. Having the same title saved is the weakest of
   them: plenty of people have Breaking Bad in a list. Putting it at number two
   of all time, or scoring it the same way someone else did, says far more.

     Top 10 agreement   0.35   ranked, deliberate, and the hardest to fake
     Rating agreement   0.30   how closely two people score what they both saw
     Genre affinity     0.20   what they gravitate to, weighted by their scores
     Library overlap    0.15   simply having the same titles

   Whatever cannot be measured for a pair is dropped and the rest renormalised,
   then the result is scaled by how much of the signal was actually present. That
   second step is what stops "we saved the same things" from reading as high as
   "we rank and score the same things".

   Different library sizes are handled by never dividing by a total. Overlap uses
   the smaller of the two libraries, ratings average over co-rated titles only,
   and Top 10 normalises against the shorter list. Somebody with 40 titles can
   read as a strong match for somebody with 900.

   If the pair has no real overlap at all, callers get null and show "Not enough
   data yet" rather than a number that means nothing. */

const WEIGHTS = { top: 0.35, ratings: 0.30, genres: 0.20, overlap: 0.15 };

// Both libraries need this many titles before any percentage is honest.
const MIN_LIBRARY = 5;
// ...and the pair needs this much genuine overlap to be worth scoring.
const MIN_SHARED = 3;
// Rating agreement is noisy below this many co-rated titles.
const MIN_CO_RATED = 3;

/* Overlap as a fraction of the smaller library (Szymkiewicz-Simpson), so a small
   focused library is not punished for being small next to a huge one. */
function overlapScore(shared, sizeA, sizeB) {
  const min = Math.min(sizeA, sizeB);
  return min > 0 ? Math.min(1, shared / min) : null;
}

/* Mean absolute difference over co-rated titles, turned into agreement. Scores
   run 1..10, so 9 is the worst possible gap and maps to 0. */
function ratingScore(pairs) {
  if (!pairs || pairs.length < MIN_CO_RATED) return null;
  let total = 0;
  for (const [a, b] of pairs) total += Math.abs(a - b);
  return Math.max(0, 1 - (total / pairs.length) / 9);
}

/* Rank weight: number one is worth ten times number ten. */
function rankWeight(position) {
  return (11 - position) / 10;
}

/* Shared Top 10 entries, worth more the higher they sit and the closer the two
   rankings agree. Normalised against a perfect match on the shorter list, so
   somebody with three picks can still reach 100 on this component. */
function topScore(aPositions, bPositions) {
  const aKeys = Object.keys(aPositions || {});
  const bKeys = Object.keys(bPositions || {});
  if (!aKeys.length || !bKeys.length) return null;

  let earned = 0;
  for (const key of aKeys) {
    const pb = bPositions[key];
    if (pb == null) continue;
    const pa = aPositions[key];
    // Same rank keeps full value; ten places apart keeps 0.64 of it.
    const closeness = 1 - (Math.abs(pa - pb) / 10) * 0.4;
    earned += Math.sqrt(rankWeight(pa) * rankWeight(pb)) * closeness;
  }

  let best = 0;
  const shorter = Math.min(aKeys.length, bKeys.length);
  for (let p = 1; p <= shorter; p++) best += rankWeight(p);
  return best > 0 ? Math.min(1, earned / best) : null;
}

/* Cosine similarity over genre weight vectors. */
function genreScore(a, b) {
  const keys = Object.keys(a || {});
  if (!keys.length || !Object.keys(b || {}).length) return null;
  let dot = 0, magA = 0, magB = 0;
  for (const k of keys) {
    magA += a[k] * a[k];
    if (b[k]) dot += a[k] * b[k];
  }
  for (const k of Object.keys(b)) magB += b[k] * b[k];
  if (!magA || !magB) return null;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(magA) * Math.sqrt(magB))));
}

/* Build the genre weight vector for one library. A title counts for more when
   the user rated it highly, so genres someone merely tried do not outweigh the
   ones they love. Unrated titles count for half. */
function genreVector(items) {
  const vec = {};
  for (const it of items) {
    const weight = it.score ? it.score / 10 : 0.5;
    for (const name of it.genres || []) {
      vec[name] = (vec[name] || 0) + weight;
    }
  }
  return vec;
}

/* Score one pair. Returns null when there is not enough between them to be
   worth a number, which the API surfaces as "Not enough data yet". */
function similarity(a, b) {
  const sizeA = a.items.length, sizeB = b.items.length;
  if (sizeA < MIN_LIBRARY || sizeB < MIN_LIBRARY) return null;

  const bById = new Map(b.items.map(it => [String(it.game_id), it]));
  const ratingPairs = [];
  let shared = 0;
  for (const it of a.items) {
    const other = bById.get(String(it.game_id));
    if (!other) continue;
    shared++;
    if (it.score && other.score) ratingPairs.push([it.score, other.score]);
  }

  let topShared = 0;
  for (const key of Object.keys(a.top || {})) {
    if (b.top && b.top[key] != null) topShared++;
  }

  // A percentage built on nothing shared is noise, however the genres line up.
  if (shared < MIN_SHARED && topShared < 1) return null;

  const parts = {
    top:     topScore(a.top, b.top),
    ratings: ratingScore(ratingPairs),
    genres:  genreScore(a.genres, b.genres),
    overlap: overlapScore(shared, sizeA, sizeB)
  };

  let total = 0, weightUsed = 0;
  for (const key of Object.keys(WEIGHTS)) {
    if (parts[key] == null) continue;
    total += parts[key] * WEIGHTS[key];
    weightUsed += WEIGHTS[key];
  }
  if (!weightUsed) return null;

  /* Components we cannot measure are not silently renormalised away. Dividing by
     the weight actually used answers "how alike are they on what we can see",
     which lets two people who merely saved the same titles, having ranked and
     rated nothing, reach the same 100% as two people whose Top 10s and scores
     agree. Those are not the same claim. The ceiling scales with how much of the
     signal is present, so the strong evidence is what buys the high numbers. */
  const confidence = 0.55 + 0.45 * weightUsed;

  return {
    percent: Math.max(1, Math.min(100, Math.round((total / weightUsed) * confidence * 100))),
    confidence,
    shared,
    topShared,
    coRated: ratingPairs.length,
    parts
  };
}

/* ── Data access ─────────────────────────────────────────────────────────── */

function parseGenres(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list.map(g => (g && g.name ? String(g.name) : '')).filter(Boolean);
}

function buildProfile(rows, topRows) {
  const items = rows.map(r => ({
    game_id: r.game_id,
    score: r.score == null ? null : Number(r.score),
    status: r.status,
    genres: parseGenres(r.genres)
  }));
  const top = {};
  for (const t of topRows || []) top[String(t.game_id)] = Number(t.position);
  return { items, top, genres: genreVector(items) };
}

/* Load the taste profiles for a set of users in two queries rather than two per
   user, so scoring a page of candidates stays flat. */
async function loadProfiles(db, userIds) {
  const ids = [...new Set(userIds.map(String))].filter(Boolean);
  if (!ids.length) return new Map();

  const [rows, topRows] = await Promise.all([
    db('user_game_lists as ugl')
      .join('games as g', 'g.id', 'ugl.game_id')
      .whereIn('ugl.user_id', ids)
      .select('ugl.user_id', 'ugl.game_id', 'ugl.score', 'ugl.status', 'g.genres'),
    db('user_top_media').whereIn('user_id', ids).select('user_id', 'game_id', 'position')
  ]);

  const byUser = new Map(ids.map(id => [id, { rows: [], top: [] }]));
  for (const r of rows) byUser.get(String(r.user_id))?.rows.push(r);
  for (const t of topRows) byUser.get(String(t.user_id))?.top.push(t);

  const out = new Map();
  for (const [id, bucket] of byUser) out.set(id, buildProfile(bucket.rows, bucket.top));
  return out;
}

/* Candidates worth scoring: people who already share titles with this user.
   Ordered by raw shared count so the expensive scoring only runs on a shortlist,
   never on the whole user table. */
async function findCandidates(db, userId, limit = 40) {
  const mine = db('user_game_lists').where('user_id', userId).select('game_id');
  const rows = await db('user_game_lists as ugl')
    .join('users as u', 'u.id', 'ugl.user_id')
    .whereIn('ugl.game_id', mine)
    .whereNot('ugl.user_id', userId)
    .where('u.is_banned', false)
    .groupBy('ugl.user_id')
    .havingRaw('count(*) >= ?', [MIN_SHARED])
    .orderByRaw('count(*) desc')
    .limit(limit)
    .select('ugl.user_id');
  return rows.map(r => String(r.user_id));
}

/* ── Cache ───────────────────────────────────────────────────────────────── */
/* The similar-people list is a shortlist plus scoring over it, which is far too
   much to redo on every profile view. It only moves when someone rates or ranks
   something, so a short TTL is plenty. In-process is deliberate: one Render
   instance, and a stale entry costs nothing worse than a slightly old ordering. */

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map();

// Misses return undefined, never null: null is a real cached value here, meaning
// "these two do not have enough between them", and recomputing it every view
// would defeat the cache for exactly the pairs that are cheapest to remember.
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { cache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= MAX_ENTRIES) {
    // Oldest insertion first, which is what Map iteration order gives us.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + TTL_MS });
}

// Anything that changes what a user has, scored, or ranked invalidates them.
function invalidate(userId) {
  if (!userId) return;
  const needle = String(userId);
  for (const key of [...cache.keys()]) {
    if (key.includes(needle)) cache.delete(key);
  }
}

module.exports = {
  WEIGHTS, MIN_LIBRARY, MIN_SHARED, MIN_CO_RATED,
  overlapScore, ratingScore, topScore, genreScore, genreVector, similarity,
  parseGenres, buildProfile, loadProfiles, findCandidates,
  cacheGet, cacheSet, invalidate
};
