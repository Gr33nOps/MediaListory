/* What else belongs to the thing you are looking at.

   Kept apart from "More like this" on purpose. Recommendations are a guess at
   taste; this is a fact about the work - the film before it, the season after
   it. Mixing the two is what makes a detail page feel like a pile of thumbnails,
   so they are built separately and rendered separately.

   How much we can honestly claim differs by provider, and the labels follow:

     - Anime: Kitsu records real `prequel` and `sequel` edges between entries, so
       walking that chain gives narrative order. Those get called prequels and
       sequels, because that is what they are.
     - Movies and games: TMDB collections and IGDB series are unordered bags of
       titles in a franchise. Release date is the only ordering available, and
       release order is not always story order - Star Wars is the standing
       counter-example. So those get called earlier and later, which is exactly
       what we know and no more.

   One rule everywhere: if the title being viewed is not itself in the list we
   got back, say nothing at all. Without knowing where the current entry sits,
   "before" and "after" are meaningless, and a list that silently omits the
   thing you are looking at is worse than no list. */

const NARRATIVE = { before: 'prequel', after: 'sequel' };
const BY_RELEASE = { before: 'earlier', after: 'later' };

function releasedAt(entry) {
  const t = Date.parse((entry && entry.released) || '');
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/**
 * Order a franchise's entries and label each one relative to the current title.
 *
 * @param entries  [{ id, name, released, image }]
 * @param currentRef  the ref of the title being viewed
 * @param opts.ordered   the list already carries a meaningful order (do not sort)
 * @param opts.narrative the provider gave real prequel/sequel edges
 * @returns [] when there is nothing worth showing, else the labelled list
 */
function buildRelations(entries, currentRef, opts = {}) {
  let list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.id && e.name);

  /* Providers repeat entries (an alternate cut under the same id, a title listed
     in two collections). Keep the first of each so nothing appears twice. */
  const seen = new Set();
  list = list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  if (!opts.ordered) list = list.slice().sort((a, b) => releasedAt(a) - releasedAt(b));

  const here = list.findIndex((e) => e.id === currentRef);
  if (here === -1 || list.length < 2) return [];

  const labels = opts.narrative ? NARRATIVE : BY_RELEASE;
  const labelled = list.map((entry, i) => ({
    id: entry.id,
    name: entry.name,
    released: entry.released || null,
    image: entry.image || null,
    relation: i === here ? 'current' : (i < here ? labels.before : labels.after)
  }));

  /* A long franchise is a strip nobody reads to the end. Keep the entries
     nearest the one being viewed, which are the ones being asked about, and
     keep the current entry in the middle so the strip reads as a position in a
     run rather than a top-N list. */
  const reach = Number(opts.reach) > 0 ? Number(opts.reach) : 6;
  return labelled.slice(Math.max(0, here - reach), here + reach + 1);
}

/* True when a labelled list actually says something: at least one entry that is
   not the title you are already looking at. */
function hasRelations(list) {
  return Array.isArray(list) && list.some((e) => e.relation !== 'current');
}

module.exports = { buildRelations, hasRelations };
