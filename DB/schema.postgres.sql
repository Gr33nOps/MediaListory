-- MediaListory canonical Postgres schema (Neon; IGDB games + TMDB movies/series)
-- Use this for new environments. Do not use the legacy MySQL dumps.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- External identity provider id (Neon Auth / Better Auth user id). Local UUID
  -- `id` stays the app's primary key so all FKs and existing code are unchanged.
  auth_id TEXT UNIQUE,
  username VARCHAR(50) UNIQUE,
  email VARCHAR(255),
  display_name VARCHAR(100),
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_moderator BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  banned_at TIMESTAMPTZ,
  banned_by UUID,
  ban_reason TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness (in addition to UNIQUE(username))
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx
  ON users (LOWER(username));

-- `games` is a generic media catalog. media_type discriminates game/movie/series.
-- game_id is the universal external ref: igdb_<id> / tmdb_movie_<id> / tmdb_series_<id>.
CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  game_id TEXT UNIQUE,
  igdb_id INTEGER UNIQUE,
  tmdb_id INTEGER,
  media_type VARCHAR(16) NOT NULL DEFAULT 'game',
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255),
  description TEXT,
  background_image TEXT,
  rating NUMERIC(4,2),
  metacritic_score INTEGER,
  playtime INTEGER DEFAULT 0,
  released DATE,
  genres JSONB DEFAULT '[]'::jsonb,
  platforms JSONB DEFAULT '[]'::jsonb,
  publishers JSONB DEFAULT '[]'::jsonb,
  developers JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_games_igdb_id ON games (igdb_id);
CREATE INDEX IF NOT EXISTS idx_games_name ON games (name);
CREATE INDEX IF NOT EXISTS idx_games_media_type ON games (media_type);
-- Movies and series share TMDB's numeric id space, so uniqueness is per media type.
CREATE UNIQUE INDEX IF NOT EXISTS games_media_tmdb_uidx
  ON games (media_type, tmdb_id) WHERE tmdb_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_game_lists (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL DEFAULT 'plan_to_play',
  score SMALLINT,
  notes TEXT, -- used by GET /api/user/export
  progress_hours NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_ugl_user_status ON user_game_lists (user_id, status);

CREATE TABLE IF NOT EXISTS custom_lists (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  description TEXT,
  cover_color VARCHAR(7) DEFAULT '#3a7bd5',
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS custom_list_games (
  id BIGSERIAL PRIMARY KEY,
  list_id BIGINT NOT NULL REFERENCES custom_lists(id) ON DELETE CASCADE,
  game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  note TEXT,
  status VARCHAR(32),
  score SMALLINT,
  position INTEGER DEFAULT 0,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (list_id, game_id)
);

-- Live app uses user_follows (not follows)
CREATE TABLE IF NOT EXISTS user_follows (
  id BIGSERIAL PRIMARY KEY,
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows (follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON user_follows (following_id);

CREATE TABLE IF NOT EXISTS ban_history (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ban_reason TEXT,
  banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unbanned_at TIMESTAMPTZ,
  unbanned_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS moderator_activity (
  id BIGSERIAL PRIMARY KEY,
  moderator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL,
  target_id TEXT,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mod_activity_created ON moderator_activity (created_at DESC);
