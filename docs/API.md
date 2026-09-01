# API ID contracts (clients)

**Product decision:** MediaListory covers three media types — **games** (IGDB / Twitch), **movies** and **series** (TMDB). Do not send `rawg_id` or assume RAWG payloads.

## Media types

Every catalog item has a `media_type`: `game` | `movie` | `series`. All three live in the one Postgres `games` table. The universal client/external id is `game_id`:

| media_type | Source | External ref (`game_id`) | Numeric id column |
|------------|--------|--------------------------|-------------------|
| `game`   | IGDB | `igdb_<id>`        | `igdb_id` |
| `movie`  | TMDB | `tmdb_movie_<id>`  | `tmdb_id` |
| `series` | TMDB | `tmdb_series_<id>` | `tmdb_id` |

## Identifiers

| Layer | Field | Format | Notes |
|-------|-------|--------|-------|
| IGDB upstream | `id` | integer | From IGDB API (games) |
| TMDB upstream | `id` | integer | From TMDB API (movies/series) |
| Client / API (external) | `game_id` or `id` on browse cards | `igdb_<id>` / `tmdb_movie_<id>` / `tmdb_series_<id>` | e.g. `igdb_1942`, `tmdb_movie_27205` |
| Postgres `games` | `id` | bigint PK | Internal FK for `user_game_lists`, custom lists (all media) |
| Postgres `games` | `media_type` | text | `game` \| `movie` \| `series` |
| Postgres `games` | `igdb_id` | integer UNIQUE | Join key for games |
| Postgres `games` | `tmdb_id` | integer | Join key for movies/series (unique per media_type) |
| Postgres `games` | `game_id` | text UNIQUE | Universal external ref |
| Users | `id` | UUID | Neon Auth user id = `public.users.id` (also stored as `auth_id`) |

### Rules for clients

1. When adding a **game** from browse/detail, send `game_data` including **`igdb_id`** (number) and metadata. When adding a **movie/series**, send `game_data` including **`media_type`** (`movie`/`series`) and **`tmdb_id`** (number) plus metadata. Bare title match is rejected.
2. Collection endpoints return `media_type` per item and may return both `game_id` (client string) and numeric DB ids depending on the route.
3. Never invent IDs. Persist only what the API returns or what the upstream (IGDB/TMDB) provided.

## Media proxies

- `POST /api/igdb/games` — games list/search/detail (structured filters: `id`, `search`, `genre`, `platform`, `publisher`, `developer`, `sort`, `sortOrder`, `comingSoon`, `limit`, `offset`). Returns raw IGDB shape.
- `POST /api/tmdb/movies` and `POST /api/tmdb/series` — movies/series list/search/detail (structured filters: `id`, `search`, `genre`, `sort`, `sortOrder`, `comingSoon`, `limit`, `offset`). Returns MediaListory-normalized objects (`id`, `media_type`, `tmdb_id`, `name`, `background_image`, `backdrop_image`, `released`, `rating`, `genres`, `developers`, `publishers`, ...).
- `POST /api/tmdb/genres` — body `{ media_type: "movie" | "series" }`, returns `[{ id, name }]`.
- All proxies require auth and write results through to the shared catalog. TMDB needs `TMDB_ACCESS_TOKEN` (v4) or `TMDB_API_KEY` (v3); when unconfigured, movie/series endpoints return `503`/`500` and games are unaffected.

## Auth

- `Authorization: Bearer <jwt>` **or** httpOnly cookie `mgl_token` (set on login / OAuth complete)
- JWT payload: `{ userId, tv }` (`tv` = `token_version`)
- Sessions: ~7d default, 30d with remember-me
- `GET /api/auth/session` - restore session from httpOnly cookie when localStorage is empty
- `POST /api/auth/oauth/complete` - body `{ access_token, rememberMe? }`; may return `needsUsername` + `suggestedUsername`
- `PUT /api/auth/username` - claim username after OAuth (auth required)
- `POST /api/auth/logout` - clears cookie (auth optional)
- Same email via Google vs Discord vs password is **not** auto-merged - see `docs/runbook.md` (Account linking)

## Versioning

- Current mounts: `/api/*`
- Compatibility aliases: `/api/v1/*` (same handlers)
- Prefer `/api/v1` for new external clients; `/api` remains for this app.

See also `docs/openapi.yaml` for the locked IGDB proxy + auth surface.
