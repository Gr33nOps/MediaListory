-- Personal profiles: bio, accent, banner style, a Top 10 per category, and an
-- opt-in choice of which in-progress titles show publicly under "Currently into".
--
-- No new image storage. avatar_url already carries a data URI on the user row and
-- is returned inline with every profile, followers list, and search result, so a
-- second uploaded image would be paid for on all of those. The banner is drawn
-- from poster art the profile already has instead.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bio          VARCHAR(300),
  -- movie | series | anime | game. NULL keeps the app default (blue).
  ADD COLUMN IF NOT EXISTS accent       VARCHAR(16),
  -- posters | accent. How the profile header is filled.
  ADD COLUMN IF NOT EXISTS banner_style VARCHAR(16);

-- A user's Top 10 of all time, kept per category. position is 1..10 and is
-- rewritten wholesale on save, so it is ordered but not uniquely constrained.
CREATE TABLE IF NOT EXISTS user_top_media (
  id         bigserial PRIMARY KEY,
  user_id    uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type varchar(16) NOT NULL,
  game_id    bigint  NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  position   smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, media_type, game_id),
  CHECK (position >= 1 AND position <= 10),
  CHECK (media_type IN ('movie', 'series', 'anime', 'game'))
);

CREATE INDEX IF NOT EXISTS utm_user_type_pos_idx ON user_top_media (user_id, media_type, position);
-- Similar Taste reads every Top 10 that contains a given title.
CREATE INDEX IF NOT EXISTS utm_game_idx ON user_top_media (game_id);

-- Which in-progress titles a user has pinned to their profile. When nothing is
-- pinned the profile falls back to their most recently updated in-progress ones,
-- so "Currently into" is useful before anyone configures it.
ALTER TABLE user_game_lists
  ADD COLUMN IF NOT EXISTS show_on_profile boolean NOT NULL DEFAULT false;

-- Similar Taste walks "everyone who also has this title", so the reverse of the
-- existing (user_id, status) index is what that lookup needs.
CREATE INDEX IF NOT EXISTS idx_ugl_game_user ON user_game_lists (game_id, user_id);
-- Scoring only ever reads rated rows, which are a fraction of most libraries.
CREATE INDEX IF NOT EXISTS idx_ugl_user_scored ON user_game_lists (user_id) WHERE score IS NOT NULL;
