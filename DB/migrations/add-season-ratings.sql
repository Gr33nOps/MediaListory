-- Season level ratings for shows and anime.
--
-- The overall score on user_game_lists is unchanged and stays the thing the
-- library, Top 10, and Similar Taste read. Seasons are optional and additive: a
-- title with no season rows behaves exactly as it did before. When someone does
-- rate seasons, the overall is recomputed from them and written back, so every
-- existing surface keeps working without knowing seasons exist.

-- The seasons a title has, cached from the provider like the rest of the catalog.
CREATE TABLE IF NOT EXISTS media_seasons (
  id            bigserial PRIMARY KEY,
  game_id       bigint NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  season_number smallint NOT NULL,
  name          varchar(255),
  episode_count integer,
  air_date      date,
  poster_image  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, season_number)
);

CREATE INDEX IF NOT EXISTS media_seasons_game_idx ON media_seasons (game_id, season_number);

-- One person's status, score, and progress for a single season. Same status
-- vocabulary and same 1..10 score as the title level, so the UI and the labels
-- are shared rather than reinvented.
CREATE TABLE IF NOT EXISTS user_season_entries (
  id            bigserial PRIMARY KEY,
  user_id       uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id       bigint NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  season_number smallint NOT NULL,
  status        varchar(32),
  score         smallint,
  progress      integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, game_id, season_number),
  CHECK (score IS NULL OR (score >= 1 AND score <= 10))
);

-- Reading one title's seasons for one person is the only access pattern.
CREATE INDEX IF NOT EXISTS use_user_game_idx ON user_season_entries (user_id, game_id, season_number);
