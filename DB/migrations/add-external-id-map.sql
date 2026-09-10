-- Cross-API id mappings (IGDB -> Steam, Kitsu -> MyAnimeList, TMDB -> TVmaze).
--
-- These are looked up so the secondary sources can be reached by exact id
-- rather than by title. They are stable and costly to rediscover, and the API
-- host sleeps on the free tier, so they are kept here rather than only in the
-- in-process cache.
--
-- A NULL external_id is a recorded absence ("this game has no Steam release"),
-- not a missing row - that is what stops a fruitless lookup repeating on every
-- page view. checked_at lets absences be re-tried occasionally.

CREATE TABLE IF NOT EXISTS media_external_ids (
  media_ref   TEXT NOT NULL,          -- games.game_id, e.g. igdb_1942 / kitsu_1
  source      VARCHAR(24) NOT NULL,   -- steam | mal | tvmaze
  external_id TEXT,                   -- NULL = confirmed absent
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (media_ref, source)
);

-- Sweeping stale absences for re-check.
CREATE INDEX IF NOT EXISTS idx_media_external_ids_checked
  ON media_external_ids (source, checked_at)
  WHERE external_id IS NULL;
