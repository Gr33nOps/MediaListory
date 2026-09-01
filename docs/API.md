# API ID contracts (clients)

**Product decision:** MediaListory covers four media types — **movies** and **series** (TMDB), **anime** (Kitsu), **games** (IGDB / Twitch). Do not send `rawg_id` or assume RAWG payloads.

## Media types

Every catalog item has a `media_type`: `movie` | `series` | `anime` | `game`, and records its `provider` (`tmdb` | `kitsu` | `igdb`) + `provider_id`. All four live in the one Postgres `games` table. The universal client/external id is `game_id`:

| media_type | Provider | External ref (`game_id`) | Numeric id column |
|------------|----------|--------------------------|-------------------|
| `movie`  | `tmdb`  | `tmdb_movie_<id>`  | `tmdb_id` |
| `series` | `tmdb`  | `tmdb_series_<id>` | `tmdb_id` |
| `anime`  | `kitsu` | `kitsu_<id>`       | — (`provider_id`) |
| `game`   | `igdb`  | `igdb_<id>`        | `igdb_id` |

A unique index on `(provider, media_type, provider_id)` guarantees IDs from different providers can never collide, even when two providers reuse the same numeric id.

## Identifiers

| Layer | Field | Format | Notes |
|-------|-------|--------|-------|
| Upstream | `id` | integer/string | From the provider API (TMDB/Kitsu/IGDB) |
| Client / API (external) | `game_id` or `id` on browse cards | `tmdb_movie_<id>` / `tmdb_series_<id>` / `kitsu_<id>` / `igdb_<id>` | e.g. `tmdb_movie_27205`, `kitsu_7442` |
| Postgres `games` | `id` | bigint PK | Internal FK for `user_game_lists`, custom lists (all media) |
| Postgres `games` | `media_type` | text | `movie` \| `series` \| `anime` \| `game` |
| Postgres `games` | `provider` | text | `tmdb` \| `kitsu` \| `igdb` |
| Postgres `games` | `provider_id` | text | External id within the provider |
| Postgres `games` | `igdb_id` | integer UNIQUE | Join key for games |
| Postgres `games` | `tmdb_id` | integer | Join key for movies/series (unique per media_type) |
| Postgres `games` | `episode_count` | integer | Total episodes (series/anime) |
| Postgres `games` | `game_id` | text UNIQUE | Universal external ref |
| Postgres `user_game_lists` | `progress` | integer | Episodes watched (series/anime) |
| Users | `id` | UUID | Local user id = `public.users.id` (external identity stored as `auth_id`) |

### Rules for clients

1. When adding an item from browse/detail, send `game_data` including **`media_type`**, **`provider`**, and **`provider_id`** plus metadata. Games also send **`igdb_id`** (number); movies/series send **`tmdb_id`** (number); anime send `provider: "kitsu"`. Bare title match is rejected.
2. Collection endpoints return `media_type` per item and may return both `game_id` (client string) and numeric DB ids depending on the route. Series/anime rows carry `episode_count` and per-user `progress`.
3. Never invent IDs. Persist only what the API returns or what the upstream (TMDB/Kitsu/IGDB) provided.

## Media proxies

- `POST /api/igdb/games` — games list/search/detail (structured filters: `id`, `search`, `genre`, `platform`, `publisher`, `developer`, `sort`, `sortOrder`, `comingSoon`, `limit`, `offset`). Returns raw IGDB shape.
- `POST /api/tmdb/movies` and `POST /api/tmdb/series` — movies/series list/search/detail (structured filters: `id`, `search`, `genre`, `sort`, `sortOrder`, `comingSoon`, `limit`, `offset`). Returns MediaListory-normalized objects (`id`, `media_type`, `provider`, `provider_id`, `tmdb_id`, `name`, `background_image`, `backdrop_image`, `released`, `rating`, `genres`, `developers`, `publishers`, ...).
- `POST /api/tmdb/genres` — body `{ media_type: "movie" | "series" }`, returns `[{ id, name }]`.
- `POST /api/kitsu/anime` — anime list/search/detail (structured filters: `id`, `search`, `genre`, `sort` (`popularity`/`rating`/`release`), `sortOrder`, `comingSoon`, `limit`, `offset`). Returns normalized objects (`id: kitsu_<id>`, `media_type: "anime"`, `provider: "kitsu"`, `provider_id`, `name`, `background_image`, `backdrop_image`, `released`, `rating`, `metacritic_score`, `number_of_episodes`, `subtype`, `status`, `genres`, ...).
- `POST /api/kitsu/genres` — Kitsu categories, returns `[{ id, name }]`.
- All proxies require a session or run guest-friendly (read-only) and write results through to the shared catalog. TMDB needs `TMDB_ACCESS_TOKEN` (v4) or `TMDB_API_KEY` (v3); **Kitsu needs no key**. When a provider is unconfigured its endpoints return `503`/`500` and the other media types are unaffected.

## Auth

- `Authorization: Bearer <jwt>` **or** httpOnly cookie `mgl_token` (set on login / OAuth complete)
- JWT payload: `{ userId, tv }` (`tv` = `token_version`)
- Sessions: ~7d default, 30d with remember-me
- `GET /api/auth/session` - restore session from httpOnly cookie when localStorage is empty
- Social sign-in (direct, same-origin OAuth2 — first-party cookies):
  - `GET /api/auth/oauth/:provider/start` (`google` | `github`) — sets a signed state cookie and redirects to the provider's consent screen. Optional `?remember=1`.
  - `GET /api/auth/oauth/:provider/callback` — verifies state, exchanges the code, maps identity to a local user (by `provider:sub` or verified email; creates on first sign-in), sets the `mgl_token` cookie, and redirects to `<FRONTEND_URL>/auth.html?oauth=done` (errors → `?oauth_error=...`).
  - `GET /api/auth/public-config` — returns `{ providers: [...] }` (only providers whose client id/secret are configured), so the UI shows the right buttons.
  - Register redirect URIs on each provider: `<FRONTEND_URL>/api/auth/oauth/google/callback` and `<FRONTEND_URL>/api/auth/oauth/github/callback`.
- `POST /api/auth/oauth/complete` - legacy token-based path (`{ access_token, rememberMe? }`); retained for compatibility, superseded by the redirect flow above.
- `PUT /api/auth/username` - claim username after OAuth (auth required)
- `POST /api/auth/logout` - clears cookie (auth optional)
- Same email via Google vs GitHub vs password is **not** auto-merged - see `docs/runbook.md` (Account linking)

## Versioning

- Current mounts: `/api/*`
- Compatibility aliases: `/api/v1/*` (same handlers)
- Prefer `/api/v1` for new external clients; `/api` remains for this app.

See also `docs/openapi.yaml` for the locked IGDB proxy + auth surface.
