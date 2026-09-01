-- MediaListory: expand the catalog from games-only to multi-media
-- (games / movies / series). Additive and data-preserving:
-- every existing row becomes media_type = 'game'.
--
-- The `games` table is now a generic media catalog. `game_id` (TEXT UNIQUE) stays
-- the universal external ref: games keep `igdb_<id>`, movies use `tmdb_movie_<id>`,
-- series use `tmdb_series_<id>`. user_game_lists / custom_list_games are unchanged
-- (they reference games.id and therefore work for every media type as-is).
--
-- Apply in the Supabase SQL editor (or via apply_migration) once the project is active.

ALTER TABLE public.games
  ADD COLUMN IF NOT EXISTS media_type VARCHAR(16) NOT NULL DEFAULT 'game',
  ADD COLUMN IF NOT EXISTS tmdb_id    INTEGER;

-- Movies and series share TMDB's numeric id space, so uniqueness is per media type.
-- (igdb_id keeps its own UNIQUE constraint; multiple NULLs are allowed in Postgres.)
CREATE UNIQUE INDEX IF NOT EXISTS games_media_tmdb_uidx
  ON public.games (media_type, tmdb_id) WHERE tmdb_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_games_media_type ON public.games (media_type);
