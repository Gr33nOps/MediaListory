-- The following feed reads every row belonging to the people you follow, newest
-- first. The existing (user_id, status) index cannot serve that ordering, so a
-- feed for someone following a few hundred accounts would sort their whole
-- combined history on every load.

CREATE INDEX IF NOT EXISTS idx_ugl_user_updated ON user_game_lists (user_id, updated_at DESC);
