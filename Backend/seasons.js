/* Season level ratings.

   A show keeps one overall score, exactly as before. Seasons sit underneath it
   and are entirely optional: rate the show and never open the seasons, and
   nothing about the old behaviour changes.

   When seasons are rated, the overall is derived from them and written back to
   user_game_lists.score. Writing it rather than only displaying it is deliberate
   here: the library badge, the Top 10, the stats page, and Similar Taste all read
   that one column, so deriving on the fly would mean teaching every one of them
   about seasons. One written value keeps them all correct and consistent.

   The maths:
     - Seasons are weighted by episode count, not averaged flat. A four episode
       season should not count the same as a twenty four episode one.
     - Only rated seasons count. Rating two of five seasons derives from those
       two rather than treating the unrated three as zero.
     - The result is rounded to a whole 1..10, because that is the only kind of
       score this app has. */

const MIN = 1, MAX = 10;

function clampScore(value) {
  // Guard these explicitly: Number(null) and Number('') are both 0, which would
  // otherwise clamp up to 1 and turn "no score" into the lowest possible rating.
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN, Math.min(MAX, n));
}

/* Derive the overall from rated seasons. Returns null when nothing is rated,
   which callers treat as "leave the overall alone". */
function deriveOverall(seasons) {
  let weighted = 0, weight = 0;
  for (const s of seasons || []) {
    const score = s.score == null ? null : Number(s.score);
    if (!score) continue;
    // An unknown episode count still counts, just as a single unit, so a season
    // the provider has no data for cannot silently vanish from the average.
    const eps = Number(s.episode_count) > 0 ? Number(s.episode_count) : 1;
    weighted += score * eps;
    weight += eps;
  }
  if (!weight) return null;
  return clampScore(weighted / weight);
}

module.exports = (db, verifyToken, checkBanned, deps = {}) => {
  const express = require('express');
  const { clientError } = require('./errors');
  const router = express.Router();

  const STATUSES = ['playing', 'completed', 'plan_to_play', 'on_hold', 'dropped'];

  /* Recompute and store the overall for one title. Called after any season write
     so the rest of the app sees a correct score without knowing seasons exist. */
  async function syncOverall(userId, gameRowId) {
    const rows = await db('user_season_entries as use')
      .leftJoin('media_seasons as ms', function () {
        this.on('ms.game_id', '=', 'use.game_id').andOn('ms.season_number', '=', 'use.season_number');
      })
      .where({ 'use.user_id': userId, 'use.game_id': gameRowId })
      .select('use.score', 'ms.episode_count');

    const derived = deriveOverall(rows);
    if (derived == null) return null; // nothing rated: the user's own score stands

    await db('user_game_lists')
      .where({ user_id: userId, game_id: gameRowId })
      .update({ score: derived, updated_at: db.fn.now() });
    return derived;
  }

  /* Seasons for a title, with this user's entries merged in. The catalog side is
     filled lazily on first view so adding a show does not fan out into a request
     per season for data nobody may ever open. */
  async function seasonsFor(userId, game) {
    let seasons = await db('media_seasons')
      .where('game_id', game.id).orderBy('season_number')
      .select('season_number', 'name', 'episode_count', 'air_date', 'poster_image');

    if (!seasons.length && deps.fetchSeasons) {
      const fetched = await deps.fetchSeasons(game).catch(() => []);
      if (fetched && fetched.length) {
        /* Pick the columns rather than spreading the source object: a provider
           adapter is free to carry extra fields of its own (the Kitsu one
           returns each season's catalog ref) and spreading them would try to
           insert columns this table does not have. */
        await db('media_seasons')
          .insert(fetched.map(s => ({
            game_id: game.id,
            season_number: s.season_number,
            name: s.name,
            episode_count: s.episode_count,
            air_date: s.air_date,
            poster_image: s.poster_image
          })))
          .onConflict(['game_id', 'season_number']).ignore();
        seasons = await db('media_seasons')
          .where('game_id', game.id).orderBy('season_number')
          .select('season_number', 'name', 'episode_count', 'air_date', 'poster_image');
      }
    }

    const mine = await db('user_season_entries')
      .where({ user_id: userId, game_id: game.id })
      .select('season_number', 'status', 'score', 'progress');
    const byNumber = new Map(mine.map(m => [Number(m.season_number), m]));

    return seasons.map(s => {
      const entry = byNumber.get(Number(s.season_number)) || {};
      return {
        season_number: Number(s.season_number),
        name: s.name,
        episode_count: s.episode_count == null ? null : Number(s.episode_count),
        air_date: s.air_date,
        poster_image: s.poster_image,
        status: entry.status || null,
        score: entry.score == null ? null : Number(entry.score),
        progress: entry.progress == null ? null : Number(entry.progress)
      };
    });
  }

  async function findTitle(userId, ref) {
    const game = await db('games').where('game_id', ref)
      .select('id', 'game_id', 'name', 'media_type', 'tmdb_id', 'provider_id').first();
    if (!game) return null;
    const owned = await db('user_game_lists')
      .where({ user_id: userId, game_id: game.id }).first();
    return owned ? game : null;
  }

  // GET /api/user/games/:ref/seasons
  router.get('/games/:ref/seasons', verifyToken, checkBanned, async (req, res) => {
    try {
      const game = await findTitle(req.userId, req.params.ref);
      if (!game) return res.status(404).json({ error: 'Not in your library' });
      if (game.media_type !== 'series' && game.media_type !== 'anime') {
        return res.json({ seasons: [], derived: null });
      }
      const seasons = await seasonsFor(req.userId, game);
      res.json({ seasons, derived: deriveOverall(seasons) });
    } catch (error) {
      return clientError(res, 400, 'Request failed', error);
    }
  });

  // PUT /api/user/games/:ref/seasons/:number
  router.put('/games/:ref/seasons/:number', verifyToken, checkBanned, async (req, res) => {
    const number = parseInt(req.params.number, 10);
    if (!Number.isInteger(number) || number < 0) {
      return res.status(400).json({ error: 'Unknown season' });
    }
    const { status, score, progress } = req.body || {};
    if (status != null && status !== '' && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    /* Rounding a decimal to a whole score is a kindness; quietly turning a 50
       into a 10 is not, so anything outside the range is refused rather than
       clamped. The dropdown cannot produce one, but the API should still say so. */
    let cleanScore = null;
    if (score !== null && score !== '' && typeof score !== 'undefined') {
      const n = Number(score);
      if (!Number.isFinite(n) || n < 1 || n > 10) {
        return res.status(400).json({ error: 'Score must be a whole number from 1 to 10.' });
      }
      cleanScore = Math.round(n);
    }

    try {
      const game = await findTitle(req.userId, req.params.ref);
      if (!game) return res.status(404).json({ error: 'Not in your library' });

      const known = await db('media_seasons')
        .where({ game_id: game.id, season_number: number }).first();
      if (!known) return res.status(404).json({ error: 'That season is not listed for this title.' });

      const row = {
        user_id: req.userId,
        game_id: game.id,
        season_number: number,
        status: status || null,
        score: cleanScore,
        progress: progress == null || progress === '' ? null : Math.max(0, parseInt(progress, 10) || 0),
        updated_at: db.fn.now()
      };
      await db('user_season_entries').insert(row)
        .onConflict(['user_id', 'game_id', 'season_number'])
        .merge(['status', 'score', 'progress', 'updated_at']);

      const derived = await syncOverall(req.userId, game.id);
      const seasons = await seasonsFor(req.userId, game);
      res.json({ seasons, derived, overall: derived });
    } catch (error) {
      return clientError(res, 400, 'Could not save that season', error);
    }
  });

  // DELETE clears one season back to untouched.
  router.delete('/games/:ref/seasons/:number', verifyToken, checkBanned, async (req, res) => {
    const number = parseInt(req.params.number, 10);
    try {
      const game = await findTitle(req.userId, req.params.ref);
      if (!game) return res.status(404).json({ error: 'Not in your library' });
      await db('user_season_entries')
        .where({ user_id: req.userId, game_id: game.id, season_number: number }).del();
      const derived = await syncOverall(req.userId, game.id);
      const seasons = await seasonsFor(req.userId, game);
      res.json({ seasons, derived, overall: derived });
    } catch (error) {
      return clientError(res, 400, 'Request failed', error);
    }
  });

  return router;
};

module.exports.deriveOverall = deriveOverall;
module.exports.clampScore = clampScore;
