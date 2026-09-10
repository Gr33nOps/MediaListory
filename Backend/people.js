/* Profiles for the names that appear beside a title.

   Three providers, three different ideas of what that name is, and no attempt
   to pretend otherwise:

     - Movies and shows list **people** - TMDB knows actors, with a biography,
       photographs and every credit across film and television.
     - Anime lists **characters** - Kitsu's cast is the cast of the story, not
       the voice actors, which is what the detail panel already shows. So the
       profile is the character's: who they are and what they appear in.
     - Games list **companies** - IGDB records studios and publishers, not
       individuals. A person profile for a game credit would be an invention;
       the studio behind it is real and is what someone clicking a developer's
       name is actually asking about.

   They are served through one endpoint and normalised to one shape, so the page
   that renders them is written once. Where a provider has nothing to say - no
   biography, no birth date - the field is simply absent rather than filled with
   a placeholder, and the page leaves it out.

   Refs are namespaced the same way media refs are: tmdb_person_<id>,
   kitsu_char_<id>, igdb_company_<id>. */

const express = require('express');
const { createTtlCache } = require('./cache');
const { clientError } = require('./errors');
const { tmdbImage } = require('./tmdbUtils');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const KITSU_BASE = 'https://kitsu.io/api/edge';
const TTL = 6 * 60 * 60 * 1000; // profiles change rarely

const REF = /^(tmdb_person|kitsu_char|igdb_company)_(\d+)$/;

function tmdbAuth() {
  const bearer = (process.env.TMDB_ACCESS_TOKEN || '').trim();
  const key = (process.env.TMDB_API_KEY || '').trim();
  return { bearer, key };
}

async function tmdbGet(path, params = {}) {
  const { bearer, key } = tmdbAuth();
  if (!bearer && !key) return null;
  const search = new URLSearchParams(params);
  const headers = { Accept: 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  else search.set('api_key', key);

  const res = await fetch(`${TMDB_BASE}${path}?${search.toString()}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

function ageFrom(birthday, deathday) {
  const born = new Date(birthday);
  if (Number.isNaN(born.getTime())) return null;
  const end = deathday ? new Date(deathday) : new Date();
  let age = end.getFullYear() - born.getFullYear();
  const m = end.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && end.getDate() < born.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function prettyDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* ── People (TMDB) ───────────────────────────────────────────────────────── */

async function tmdbPerson(id) {
  const data = await tmdbGet(`/person/${id}`, {
    language: 'en-US',
    append_to_response: 'combined_credits,images'
  });
  if (!data || !data.name) return null;

  /* Acting credits, best known first. TMDB's popularity is the only signal it
     gives for "which of these forty titles is this person known for", and
     ordering by date instead buries the famous role under recent television.

     But popularity alone is wrong: it puts talk shows first, because a chat
     show airing nightly outranks a film. Cillian Murphy's credits opened with
     three guest appearances as himself, above Peaky Blinders. Appearances as
     oneself are not roles, so they are dropped along with the talk and news
     formats they belong to. */
  const asSelf = /^(self|himself|herself|themselves)/i;
  const CHAT_OR_NEWS = new Set([10767, 10763]);

  const credits = (data.combined_credits && data.combined_credits.cast ? data.combined_credits.cast : [])
    .filter((c) => c && (c.title || c.name) && (c.media_type === 'movie' || c.media_type === 'tv'))
    .filter((c) => !asSelf.test(String(c.character || '')))
    .filter((c) => !(c.genre_ids || []).some((g) => CHAT_OR_NEWS.has(Number(g))))
    .map((c) => ({
      ref: `tmdb_${c.media_type === 'tv' ? 'series' : 'movie'}_${c.id}`,
      media_type: c.media_type === 'tv' ? 'series' : 'movie',
      name: c.title || c.name,
      image: tmdbImage(c.poster_path, 'w185'),
      released: c.release_date || c.first_air_date || null,
      role: c.character || null,
      episodes: c.episode_count || null,
      weight: Number(c.popularity) || 0
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 60)
    .map(({ weight, ...credit }) => credit);

  const age = ageFrom(data.birthday, data.deathday);
  const facts = [
    data.known_for_department ? { label: 'Known for', value: data.known_for_department } : null,
    data.birthday ? {
      label: 'Born',
      value: prettyDate(data.birthday) + (age != null && !data.deathday ? ` (age ${age})` : '')
    } : null,
    data.deathday ? { label: 'Died', value: prettyDate(data.deathday) + (age != null ? ` (aged ${age})` : '') } : null,
    data.place_of_birth ? { label: 'From', value: data.place_of_birth } : null,
    credits.length ? { label: 'Credits', value: String(credits.length) } : null
  ].filter(Boolean);

  return {
    ref: `tmdb_person_${id}`,
    kind: 'person',
    name: data.name,
    image: tmdbImage(data.profile_path, 'h632'),
    summary: (data.biography || '').trim() || null,
    facts,
    gallery: ((data.images && data.images.profiles) || [])
      .slice(0, 10)
      .map((p) => tmdbImage(p.file_path, 'w185'))
      .filter(Boolean),
    credits,
    source: { name: 'TMDB', url: `https://www.themoviedb.org/person/${id}` }
  };
}

/* ── Characters (Kitsu) ──────────────────────────────────────────────────── */

const KITSU_HEADERS = { Accept: 'application/vnd.api+json' };

async function kitsuGet(path) {
  const res = await fetch(`${KITSU_BASE}${path}`, { headers: KITSU_HEADERS });
  if (!res.ok) return null;
  return res.json();
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

async function kitsuCharacter(id) {
  const data = await kitsuGet(`/characters/${id}`);
  const attrs = data && data.data && data.data.attributes;
  if (!attrs || !attrs.name) return null;

  /* Which anime this character turns up in. Kitsu keeps that on a join table,
     and including the anime avoids a request per appearance. */
  const appearances = await kitsuGet(
    `/characters/${encodeURIComponent(id)}/media-characters?include=media&page[limit]=20`
  ).catch(() => null);

  const media = {};
  ((appearances && appearances.included) || []).forEach((r) => {
    if (r && r.type === 'anime' && r.id) media[r.id] = r.attributes || {};
  });

  const credits = ((appearances && appearances.data) || [])
    .map((mc) => {
      const rel = mc.relationships && mc.relationships.media && mc.relationships.media.data;
      if (!rel || rel.type !== 'anime') return null;
      const a = media[rel.id];
      if (!a || !(a.canonicalTitle || (a.titles && a.titles.en))) return null;
      const poster = a.posterImage || {};
      return {
        ref: `kitsu_${rel.id}`,
        media_type: 'anime',
        name: a.canonicalTitle || a.titles.en,
        image: poster.medium || poster.large || poster.original || null,
        released: a.startDate || null,
        role: mc.attributes && mc.attributes.role === 'main' ? 'Main character' : 'Supporting',
        weight: mc.attributes && mc.attributes.role === 'main' ? 1 : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight || String(a.released || '').localeCompare(String(b.released || '')))
    .map(({ weight, ...credit }) => credit);

  const image = attrs.image || {};
  const otherNames = (attrs.otherNames || []).filter(Boolean).slice(0, 4);

  return {
    ref: `kitsu_char_${id}`,
    kind: 'character',
    name: attrs.name,
    image: image.original || image.large || image.medium || null,
    summary: stripTags(attrs.description) || null,
    facts: [
      otherNames.length ? { label: 'Also known as', value: otherNames.join(', ') } : null,
      credits.length ? { label: 'Appears in', value: String(credits.length) } : null
    ].filter(Boolean),
    gallery: [],
    credits,
    source: { name: 'Kitsu', url: `https://kitsu.app/characters/${attrs.slug || id}` }
  };
}

/* ── Companies (IGDB) ────────────────────────────────────────────────────── */

function igdbCover(url, size = 't_cover_small') {
  return url ? 'https:' + String(url).replace('t_thumb', size) : null;
}

async function igdbCompany(id, igdbFetch) {
  if (typeof igdbFetch !== 'function') return null;
  const res = await igdbFetch('/companies',
    'fields name, description, start_date, country, logo.url, ' +
    'developed.name, developed.cover.url, developed.first_release_date, ' +
    'published.name, published.cover.url, published.first_release_date; ' +
    `where id = ${Number(id)};`);
  if (!res || !res.ok) return null;
  const rows = await res.json();
  const company = Array.isArray(rows) ? rows[0] : null;
  if (!company || !company.name) return null;

  /* A studio that both made and published a game would otherwise list it twice.
     Developed wins, because that is the stronger claim. */
  const seen = new Set();
  const collect = (games, role) => (games || [])
    .filter((g) => g && g.name && !seen.has(g.id) && seen.add(g.id))
    .map((g) => ({
      ref: `igdb_${g.id}`,
      media_type: 'game',
      name: g.name,
      image: igdbCover(g.cover && g.cover.url),
      released: g.first_release_date
        ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10)
        : null,
      role
    }));

  const credits = collect(company.developed, 'Developer')
    .concat(collect(company.published, 'Publisher'))
    .sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')))
    .slice(0, 60);

  return {
    ref: `igdb_company_${id}`,
    kind: 'company',
    name: company.name,
    image: igdbCover(company.logo && company.logo.url, 't_logo_med'),
    summary: (company.description || '').trim() || null,
    facts: [
      company.start_date ? { label: 'Founded', value: prettyDate(company.start_date * 1000) } : null,
      credits.length ? { label: 'Games', value: String(credits.length) } : null
    ].filter(Boolean),
    gallery: [],
    credits,
    source: { name: 'IGDB', url: `https://www.igdb.com/companies/${company.slug || id}` }
  };
}

/* ── Search ──────────────────────────────────────────────────────────────── */

async function searchPeople(query) {
  const data = await tmdbGet('/search/person', { query, include_adult: 'false', language: 'en-US' });
  if (!data || !Array.isArray(data.results)) return [];
  return data.results
    .filter((p) => p && p.name)
    .slice(0, 8)
    .map((p) => ({
      ref: `tmdb_person_${p.id}`,
      name: p.name,
      image: tmdbImage(p.profile_path, 'w185'),
      /* What the name means to someone scanning a list. A person's own titles
         say far more than "Acting" does. */
      note: (p.known_for || [])
        .map((k) => k.title || k.name)
        .filter(Boolean)
        .slice(0, 2)
        .join(', ') || p.known_for_department || ''
    }));
}

module.exports = (verifyToken, checkBanned, deps = {}) => {
  const router = express.Router();
  const cache = createTtlCache();

  router.use(verifyToken, checkBanned);

  // POST /api/people  { ref }
  router.post('/', async (req, res) => {
    const ref = String((req.body && req.body.ref) || '');
    const parsed = REF.exec(ref);
    if (!parsed) return res.status(400).json({ error: 'Unknown profile' });

    const [, kind, id] = parsed;
    const cached = cache.get(ref);
    if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }

    try {
      let profile = null;
      if (kind === 'tmdb_person') profile = await tmdbPerson(id);
      else if (kind === 'kitsu_char') profile = await kitsuCharacter(id);
      else if (kind === 'igdb_company') profile = await igdbCompany(id, deps.igdbFetch);

      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      cache.set(ref, profile, TTL);
      res.setHeader('X-Cache', 'MISS');
      return res.json(profile);
    } catch (error) {
      return clientError(res, 502, 'Could not load that profile', error);
    }
  });

  // POST /api/people/search  { query }
  router.post('/search', async (req, res) => {
    const query = String((req.body && req.body.query) || '').trim().slice(0, 80);
    if (query.length < 2) return res.json([]);

    const key = `search:${query.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }

    try {
      const results = await searchPeople(query);
      cache.set(key, results, 30 * 60 * 1000);
      return res.json(results);
    } catch (error) {
      // A failed people lookup must never break the title search beside it.
      return res.json([]);
    }
  });

  return router;
};

module.exports.ageFrom = ageFrom;
module.exports.prettyDate = prettyDate;
module.exports.stripTags = stripTags;
