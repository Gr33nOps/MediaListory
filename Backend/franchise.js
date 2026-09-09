/* Grouping an anime franchise back into one entry.

   TMDB models a show as one id with seasons hanging off it. Kitsu does not:
   every season of Attack on Titan is its own top-level anime with its own id,
   so a search for it returns eight separate results and the browse grid reads
   like a shelf of near-duplicates.

   There is no franchise field to ask for, and walking Kitsu's `sequel`
   relationships costs one request per title, which a 24 tile grid cannot pay.
   What is free is the title itself: Kitsu names sequels off their parent
   ("Attack on Titan Season 2", "Attack on Titan: The Final Season"), so
   stripping a recognised season marker lands back on the parent's title.

   That is a heuristic, so it is deliberately timid. Stripping must actually
   change the title for an entry to count as a sequel at all, and a sequel is
   only ever folded into a parent that is really there. Two titles that merely
   look alike ("Fate/Zero", "Fate/stay night") strip to themselves and are left
   alone. The cost of being wrong is a hidden entry, so the rule is: when in
   doubt, show it. */

/* Ordered so the longest, most specific markers are tried first: "The Final
   Season Part 2" must not be caught by the bare "Part 2" rule and leave a
   dangling "Attack on Titan: The Final Season". Each pattern eats the rest of
   the title, because anything after a season marker is a qualifier on it. */
const MARKERS = [
  /[\s:;,\-–—]*\b(?:the\s+)?(?:final|last)\s+(?:season|chapter)\b.*$/i,
  /[\s:;,\-–—]*\bseason\s+\d+\b.*$/i,
  /[\s:;,\-–—]*\b\d+(?:st|nd|rd|th)\s+season\b.*$/i,
  /* Written out rather than numbered: Kitsu carries "Haikyuu!! Second Season"
     right alongside "Boku no Hero Academia 2nd Season". */
  /[\s:;,\-–—]*\b(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+season\b.*$/i,
  /[\s:;,\-–—]*\bpart\s+\d+\b.*$/i,
  /[\s:;,\-–—]*\bcour\s+\d+\b.*$/i,
  /[\s:;,\-–—]*\b(?:2nd|3rd|4th|5th)\s+(?:stage|series)\b.*$/i,
  /\s+(?:ii|iii|iv|vi|vii|viii|ix)$/i,
  /* A bare trailing digit, but only 2..9. Anything else is part of the name
     rather than a sequel number: "Steins;Gate 0", "Mob Psycho 100", "86". */
  /\s+[2-9]$/
];

function tidy(name) {
  return String(name || '')
    .replace(/[\s:;,\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(name) {
  return tidy(name).toLowerCase();
}

/* The franchise a title belongs to, plus whether it looked like a sequel.
   `isSequel` is what keeps unrelated lookalikes apart: only a title that
   actually carried a season marker may be folded into another entry. */
function franchiseOf(name) {
  let base = tidy(name);
  let stripped = false;
  /* Loop, because real titles stack markers: "Season 2 Part 2". Stop on the
     first pass that changes nothing, and never strip a title down to nothing. */
  for (let guard = 0; guard < 4; guard++) {
    let changed = false;
    for (const re of MARKERS) {
      const next = tidy(base.replace(re, ''));
      if (next && next !== base) { base = next; changed = true; stripped = true; break; }
    }
    if (!changed) break;
  }
  return { key: normalize(base), base, isSequel: stripped };
}

function franchiseKey(name) {
  return franchiseOf(name).key;
}

/* What counts as a season rather than as extra material. A franchise text
   search drags in recaps, music videos, shorts and compilation movies; none of
   those are a season, and numbering them as one would be wrong in the library
   and overstated on a tile. Subtype is only checked when the provider gave one,
   so a catalog row served from our own database is not silently disqualified. */
const SEASON_SUBTYPES = new Set(['TV', 'ONA']);

function isSeasonLike(item) {
  if (!item) return false;
  if (item.subtype && !SEASON_SUBTYPES.has(item.subtype)) return false;
  return Number(item.number_of_episodes) >= 2;
}

function airDate(item) {
  const t = Date.parse(item && item.released ? item.released : '');
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Collapse a list of normalized anime into one entry per franchise.
 *
 * Order is preserved: the grid stays sorted the way the provider sorted it,
 * and a folded-away sequel never promotes anything up the page.
 *
 * @param items normalized media objects
 * @param opts.seen a Set of franchise keys already shown (for "load more",
 *        where a sequel can land on a later page than its parent)
 * @returns the collapsed list; each surviving entry gains `franchise_key` and,
 *          when it absorbed other seasons, `franchise_count`.
 */
function collapseFranchises(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const seen = opts.seen instanceof Set ? opts.seen : new Set();

  // A sequel may only fold into a parent that is present in this very batch.
  const parents = new Map();
  for (const item of list) {
    if (!item) continue;
    const f = franchiseOf(item.name);
    if (!f.isSequel && !parents.has(f.key)) parents.set(f.key, item);
  }

  const members = new Map(); // key -> [items], parent included
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const f = franchiseOf(item.name);
    const parent = parents.get(f.key);

    /* No parent here means we have nothing honest to fold this into, so it is
       shown as itself rather than hidden behind a title we invented. */
    if (!parent) { out.push(item); continue; }

    /* Only a title that actually read as a sequel may be folded away. Kitsu
       does carry genuine duplicates of a name (the TV cut and the movie cut of
       Mugen Train are both "Kimetsu no Yaiba: Mugen Ressha-hen"), and hiding
       one behind the other would lose a real, separate entry. */
    if (item !== parent && !f.isSequel) { out.push(item); continue; }

    if (!members.has(f.key)) members.set(f.key, []);
    members.get(f.key).push(item);

    if (item === parent) {
      if (seen.has(f.key)) continue; // parent already on an earlier page
      seen.add(f.key);
      out.push(item);
    }
  }

  /* Annotate off the parent map rather than off `out`'s order: a sequel can
     outrank its parent in the provider's sort, so the first member seen is not
     reliably the entry that survived. */
  for (const [key, parent] of parents) {
    const group = members.get(key);
    if (!group || !out.includes(parent)) continue;
    parent.franchise_key = key;
    /* How many seasons this one tile stands for, counting seasons only and not
       the extras that were folded away with them.

       Nothing renders this today, on purpose. It is a count of what was folded
       on this page, and a browse page only ever sees a slice of a franchise, so
       printing it on a tile would have Attack on Titan reading "4 seasons"
       while search and the library both say 6. It is kept because it is the
       honest answer to "what did this tile absorb", which is what callers and
       tests need to know. */
    const seasonMembers = group.filter(isSeasonLike);
    if (seasonMembers.length > 1) parent.franchise_count = seasonMembers.length;
  }
  return out;
}

/**
 * Turn the members of a franchise into a season list, oldest first.
 * Used for anime, where a "season" is a sibling catalog entry.
 */
function membersToSeasons(baseName, items) {
  const key = franchiseKey(baseName);
  return (Array.isArray(items) ? items : [])
    .filter((m) => m && isSeasonLike(m) && franchiseKey(m.name) === key)
    .sort((a, b) => airDate(a) - airDate(b))
    .map((m, i) => ({
      season_number: i + 1,
      name: m.name,
      episode_count: m.number_of_episodes != null ? Number(m.number_of_episodes) || null : null,
      air_date: m.released || null,
      poster_image: m.background_image || null,
      external_ref: m.id || null
    }));
}

module.exports = { franchiseOf, franchiseKey, collapseFranchises, membersToSeasons, isSeasonLike };
