-- MediaListory: add Anime (Kitsu) as a first-class media type, an explicit
-- provider / provider_id (so IDs from different providers can never collide),
-- and per-type progress metadata (episode progress for series/anime).
--
-- media_type: game | movie | series | anime
-- provider:   igdb | tmdb | kitsu
-- game_id stays the universal external ref: igdb_<id> / tmdb_movie_<id> /
-- tmdb_series_<id> / kitsu_<id>. (kept for backward compatibility)

ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS provider      VARCHAR(16),
  ADD COLUMN IF NOT EXISTS provider_id   TEXT,
  ADD COLUMN IF NOT EXISTS episode_count INTEGER;

-- Backfill provider/provider_id for existing rows.
UPDATE public.games SET provider = 'igdb', provider_id = igdb_id::text
  WHERE provider IS NULL AND igdb_id IS NOT NULL;
UPDATE public.games SET provider = 'tmdb', provider_id = tmdb_id::text
  WHERE provider IS NULL AND tmdb_id IS NOT NULL;

-- Hard collision guard across providers: (provider, media_type, provider_id) is unique.
CREATE UNIQUE INDEX IF NOT EXISTS games_provider_media_uidx
  ON public.games (provider, media_type, provider_id)
  WHERE provider IS NOT NULL AND provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_games_provider ON public.games (provider);

-- Episode/step progress for the user's tracked media (series/anime "episodes watched").
-- Games keep using progress_hours for playtime.
ALTER TABLE public.user_game_lists
  ADD COLUMN IF NOT EXISTS progress INTEGER;
