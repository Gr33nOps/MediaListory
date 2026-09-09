/* Where a title's season list comes from.

   TMDB returns the whole season list on the series detail response, so listing
   the seasons for a show costs one call and no per-season requests. Episode
   counts come with it, which is also what fixes the missing episode_count on
   series rows.

   Anime has no such endpoint. Kitsu models each season as its own top-level
   entry rather than as a child of one show, so an anime's "seasons" are its
   sibling entries, and there are two ways to find them.

   The cheap way is one text search for the franchise title: Kitsu names sequels
   off their parent, so the siblings come back together and Backend/franchise.js
   decides which of them are genuinely the same franchise. That is a single call
   and it answers for most shows.

   It cannot answer for a franchise whose seasons are named by arc rather than
   numbered - Demon Slayer's seasons are "Yuukaku-hen" and "Katanakaji no
   Sato-hen", which share no title stem to strip. For those, fall back to
   walking Kitsu's `sequel` relationships, which is the authoritative answer:
   one request per hop, so it costs a handful of calls, which is why it is the
   fallback and not the default. It runs once per title, when someone actually
   opens the seasons panel, and the result is cached in media_seasons.

   Only `sequel` and `prequel` are followed. Kitsu also carries side_story,
   spin_off, summary, alternative_version, character and adaptation, and every
   one of those would drag in something that is not a season.

   Either way, anything without a real episode count and anything that is not a
   TV or ONA run is left out: specials, recaps and movies are not seasons and
   should not become numbered ones. */

const { membersToSeasons, franchiseOf, isSeasonLike } = require('./franchise');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const KITSU_BASE = 'https://kitsu.io/api/edge';

function tmdbAuth() {
  const bearer = (process.env.TMDB_ACCESS_TOKEN || '').trim();
  const key = (process.env.TMDB_API_KEY || '').trim();
  return { bearer, key };
}

function tmdbImage(path, size = 'w300') {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

async function fetchTmdbSeasons(tmdbId) {
  const { bearer, key } = tmdbAuth();
  if (!bearer && !key) return [];

  const params = new URLSearchParams();
  const headers = { Accept: 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else params.set('api_key', key);

  const res = await fetch(`${TMDB_BASE}/tv/${encodeURIComponent(tmdbId)}?${params.toString()}`, { headers });
  if (!res.ok) return [];
  const body = await res.json();

  return (body.seasons || [])
    // Season 0 is TMDB's bucket for specials and one-offs. Leaving it out keeps
    // the dropdown to the seasons people actually think of as seasons.
    .filter(s => Number(s.season_number) >= 1 && Number(s.episode_count) > 0)
    .map(s => ({
      season_number: Number(s.season_number),
      name: s.name || `Season ${s.season_number}`,
      episode_count: Number(s.episode_count) || null,
      air_date: s.air_date || null,
      poster_image: tmdbImage(s.poster_path)
    }));
}

const KITSU_HEADERS = { Accept: 'application/vnd.api+json' };
const HOP_LIMIT = 12;      // no franchise runs longer than this; a cycle cannot outlast it
const HOP_DELAY_MS = 120;  // Kitsu is a free service; walk it at the same pace as the proxy

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function kitsuMedia(id, attributes) {
  const at = attributes || {};
  return {
    id: `kitsu_${id}`,
    name: at.canonicalTitle || (at.titles && (at.titles.en || at.titles.en_jp)) || '',
    released: at.startDate || null,
    background_image: (at.posterImage && (at.posterImage.large || at.posterImage.medium)) || null,
    number_of_episodes: at.episodeCount != null ? Number(at.episodeCount) : null,
    subtype: at.subtype || null
  };
}

/* The franchise siblings that share this title's stem. One call. */
async function seasonsByTitle(name) {
  const { base } = franchiseOf(name);
  if (!base) return [];

  const res = await fetch(`${KITSU_BASE}/anime?filter[text]=${encodeURIComponent(base)}&page[limit]=20`, { headers: KITSU_HEADERS });
  if (!res.ok) return [];
  const body = await res.json();

  const candidates = (body.data || [])
    .map((a) => kitsuMedia(a.id, a.attributes))
    .filter((m) => m.name);
  return membersToSeasons(base, candidates);
}

/* One hop of the relationship graph: this entry's direct sequel and prequel. */
async function neighbours(kitsuId) {
  const res = await fetch(
    `${KITSU_BASE}/anime/${encodeURIComponent(kitsuId)}/media-relationships?include=destination&page[limit]=20`,
    { headers: KITSU_HEADERS }
  );
  if (!res.ok) return {};
  const body = await res.json();

  const byId = {};
  (body.included || []).forEach((r) => { if (r && r.type === 'anime' && r.id) byId[r.id] = r.attributes; });

  const found = {};
  for (const rel of body.data || []) {
    const role = rel.attributes && rel.attributes.role;
    if (role !== 'sequel' && role !== 'prequel') continue;
    const dst = rel.relationships && rel.relationships.destination && rel.relationships.destination.data;
    if (!dst || dst.type !== 'anime' || found[role]) continue;
    found[role] = { id: dst.id, media: kitsuMedia(dst.id, byId[dst.id]) };
  }
  return found;
}

/* Walk the sequel chain to the whole run, in broadcast order. Starts by walking
   backwards, because the entry someone added may be the third season, not the
   first. */
async function seasonsByChain(kitsuId) {
  if (!kitsuId) return [];

  let head = String(kitsuId);
  const seenBack = new Set([head]);
  for (let i = 0; i < HOP_LIMIT; i++) {
    const near = await neighbours(head);
    if (!near.prequel || seenBack.has(near.prequel.id)) break;
    head = near.prequel.id;
    seenBack.add(head);
    await wait(HOP_DELAY_MS);
  }

  const chain = [];
  let cursor = head;
  const seenForward = new Set();
  for (let i = 0; i < HOP_LIMIT && !seenForward.has(cursor); i++) {
    seenForward.add(cursor);
    const near = await neighbours(cursor);
    if (!near.sequel) break;
    chain.push(near.sequel.media);
    cursor = near.sequel.id;
    await wait(HOP_DELAY_MS);
  }
  if (!chain.length) return [];

  /* The head is nobody's sequel, so its own attributes never arrive as part of
     a hop. Fetch it directly rather than leaving season 1 out of its own run. */
  const headRes = await fetch(`${KITSU_BASE}/anime/${encodeURIComponent(head)}`, { headers: KITSU_HEADERS });
  if (!headRes.ok) return [];
  const headBody = await headRes.json();
  if (!headBody.data) return [];
  chain.unshift(kitsuMedia(headBody.data.id, headBody.data.attributes));

  /* Numbered by the chain's own order rather than by air date: the chain is the
     provider saying "this one follows that one", which is better evidence. */
  return chain
    .filter((m) => m.name && isSeasonLike(m))
    .map((m, i) => ({
      season_number: i + 1,
      name: m.name,
      episode_count: m.number_of_episodes || null,
      air_date: m.released || null,
      poster_image: m.background_image || null,
      external_ref: m.id
    }));
}

async function fetchKitsuSeasons(game) {
  const byTitle = await seasonsByTitle(game && game.name).catch(() => []);
  if (byTitle.length > 1) return byTitle;

  const byChain = await seasonsByChain(game && game.provider_id).catch(() => []);
  if (byChain.length > 1) return byChain;

  /* One entry is not a season list, it is just the show itself. A lone
     "Season 1" repeating the title would be noise, so say nothing. */
  return [];
}

/* Called with the catalog row. Returns [] for anything without a season concept,
   which the caller treats as "this title simply has no seasons". */
async function fetchSeasons(game) {
  if (!game) return [];
  if (game.media_type === 'series' && game.tmdb_id) {
    return fetchTmdbSeasons(game.tmdb_id);
  }
  if (game.media_type === 'anime') {
    return fetchKitsuSeasons(game);
  }
  return [];
}

module.exports = { fetchSeasons, fetchTmdbSeasons, fetchKitsuSeasons };
