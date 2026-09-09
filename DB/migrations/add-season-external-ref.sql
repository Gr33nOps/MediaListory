-- Ties a cached season back to the catalog entry it came from.
--
-- For a show this is null: TMDB models seasons as children of one series, so a
-- season is not a catalog entry in its own right. For anime it is the whole
-- point - Kitsu models every season as its own top-level anime, so a season
-- really is another row in `games`, and this is its ref (kitsu_<id>).
--
-- What needs it: importing a MyAnimeList export. MAL has one row per season,
-- each with its own score, and folding those onto the parent's season list
-- means knowing which season each row is. Matching on the displayed name would
-- work today and break the day a provider renames something; the ref will not.

ALTER TABLE media_seasons ADD COLUMN IF NOT EXISTS external_ref varchar(64);

-- Looking a season up by ref is exactly the import's access pattern.
CREATE INDEX IF NOT EXISTS media_seasons_ref_idx ON media_seasons (external_ref)
  WHERE external_ref IS NOT NULL;
