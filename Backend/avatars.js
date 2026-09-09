/* Avatars.

   An uploaded avatar is stored as a data URI on the user row. That was being
   sent inline with every response carrying a user: your own profile, someone
   else's profile, search results, followers, following, discovery, and every row
   of the activity feed. Measured on a real account it was 257,382 bytes against
   302 bytes for the entire rest of the profile payload, and apiFetch sends
   `cache: no-store`, so it came down again on every single page load. A feed of
   25 rows from a handful of people with uploaded pictures is several megabytes.

   It is served from its own URL instead:

     - List and profile queries never select the data URI. A CASE in SQL returns
       remote (OAuth) avatars as-is and collapses uploaded ones to a flag, so a
       quarter of a megabyte per row never leaves Postgres either.
     - The URL carries the user's updated_at as a version, and the response is
       immutable and cached for a year. Changing your picture bumps updated_at,
       which changes the URL, so a new one appears immediately without ever
       serving a stale image.
     - The route is unauthenticated because <img> cannot send a bearer token.
       That matches the existing exposure: avatars already appear in search
       results and follower lists to any signed-in user, and user ids are UUIDs,
       so nothing here is enumerable. */

const crypto = require('crypto');

const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i;

const EXT_FOR = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/* Columns to select in place of avatar_url. `alias` is the table alias in the
   query. Keeps the big value in the database and brings back only what is
   needed to build a URL. */
function columns(db, alias = 'users') {
  return [
    db.raw(`CASE WHEN ${alias}.avatar_url LIKE 'data:%' THEN NULL ELSE ${alias}.avatar_url END as avatar_remote`),
    db.raw(`(${alias}.avatar_url IS NOT NULL AND ${alias}.avatar_url LIKE 'data:%') as avatar_uploaded`),
    db.raw(`${alias}.updated_at as avatar_version`),
    // Cheap prefix test so the URL can flag an animated picture. The
    // reduced-motion code needs to know without downloading it first.
    db.raw(`(${alias}.avatar_url LIKE 'data:image/gif;%') as avatar_gif`)
  ];
}

function originOf(req) {
  // Render terminates TLS in front of the app, so this needs `trust proxy` set
  // for req.protocol to be https rather than http. Without it every avatar URL
  // would be blocked as mixed content on the https frontend.
  return req.protocol + '://' + req.get('host');
}

/* Build the public URL for a row selected with `columns()`. Remote avatars are
   passed straight through rather than proxied. */
function urlFor(req, row) {
  if (!row) return null;
  if (row.avatar_uploaded) {
    const stamp = row.avatar_version ? new Date(row.avatar_version).getTime() : 0;
    return `${originOf(req)}/api/users/${row.id}/avatar?v=${stamp}` + (row.avatar_gif ? '&t=gif' : '');
  }
  return row.avatar_remote || null;
}

/* Same idea for a row that was selected with `SELECT *` and so already carries
   the data URI. The value never reaches the client either way; this just avoids
   having to rewrite every query at once. */
function fromValue(req, id, value, updatedAt) {
  if (!value) return null;
  if (!req || !id || !/^data:/i.test(value)) return value;
  const stamp = updatedAt ? new Date(updatedAt).getTime() : 0;
  const gif = /^data:image\/gif;/i.test(value) ? '&t=gif' : '';
  return `${originOf(req)}/api/users/${id}/avatar?v=${stamp}${gif}`;
}

/* Swap the helper columns for a plain avatar_url on an outgoing object, so the
   shape the frontend already expects does not change. */
function decorate(req, row) {
  if (!row) return row;
  const out = { ...row, avatar_url: urlFor(req, row) };
  delete out.avatar_remote;
  delete out.avatar_uploaded;
  delete out.avatar_version;
  delete out.avatar_gif;
  return out;
}

function decorateAll(req, rows) {
  return (rows || []).map(r => decorate(req, r));
}

/* The route itself. Registered without verifyToken on purpose (see the note at
   the top of this file). */
function handler(db) {
  return async (req, res) => {
    try {
      const row = await db('users')
        .where({ id: req.params.userId })
        .select('avatar_url', 'is_banned')
        .first();
      if (!row || row.is_banned || !row.avatar_url) return res.status(404).end();

      const match = DATA_URI.exec(row.avatar_url);
      // Only uploaded avatars are ever addressed by this route: urlFor hands out
      // the provider's own URL for a remote one. Redirecting to whatever the
      // column holds would turn this into an open redirect, and the value can
      // come from an OAuth provider rather than our own validation, so a
      // non-upload here is simply not found.
      if (!match) return res.status(404).end();

      const mime = match[1].toLowerCase();
      if (!EXT_FOR[mime]) return res.status(404).end();

      const body = Buffer.from(match[2], 'base64');
      // sha256 rather than sha1: this is only a cache validator, but the
      // project's CI fails the build on any weak-algorithm finding.
      const etag = '"' + crypto.createHash('sha256').update(body).digest('base64') + '"';

      res.set({
        'Content-Type': mime,
        'Content-Length': String(body.length),
        'ETag': etag,
        // The URL changes whenever the picture does, so this can be cached hard.
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Lets the reduced-motion code paint frame one of an animated avatar to
        // a canvas without tainting it.
        'Access-Control-Allow-Origin': '*',
        /* The app's default is same-origin, which is right for the API but wrong
           here: the frontend is on Vercel and this is served from Render, so a
           same-origin policy makes the browser refuse to render the <img> at all
           and every avatar silently falls back to the generated initials. This
           is a public profile picture meant to be embedded, so it opts out. */
        'Cross-Origin-Resource-Policy': 'cross-origin'
      });

      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      return res.end(body);
    } catch (error) {
      console.error('Avatar fetch error:', error);
      return res.status(404).end();
    }
  };
}

module.exports = { columns, urlFor, fromValue, decorate, decorateAll, handler, EXT_FOR };
