# API ID contracts (clients)

**Product decision:** MediaListory covers four media types - **movies** and **series** (TMDB), **anime** (Kitsu), **games** (IGDB / Twitch). Do not send `rawg_id` or assume RAWG payloads.

## Media types

Every catalog item has a `media_type`: `movie` | `series` | `anime` | `game`, and records its `provider` (`tmdb` | `kitsu` | `igdb`) + `provider_id`. All four live in the one Postgres `games` table. The universal client/external id is `game_id`:

| media_type | Provider | External ref (`game_id`) | Numeric id column |
|------------|----------|--------------------------|-------------------|
| `movie`  | `tmdb`  | `tmdb_movie_<id>`  | `tmdb_id` |
| `series` | `tmdb`  | `tmdb_series_<id>` | `tmdb_id` |
| `anime`  | `kitsu` | `kitsu_<id>`       | - (`provider_id`) |
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

- `POST /api/igdb/games` - games list/search/detail (structured filters: `id`, `search`, `genre`, `platform`, `publisher`, `developer`, `sort`, `sortOrder`, `comingSoon`, `limit`, `offset`). Returns raw IGDB shape.
- `POST /api/tmdb/movies` and `POST /api/tmdb/series` - movies/series list/search/detail (structured filters: `id`, `search`, `genre`, `sort`, `sortOrder`, `comingSoon`, `limit`, `offset`). Returns MediaListory-normalized objects (`id`, `media_type`, `provider`, `provider_id`, `tmdb_id`, `name`, `background_image`, `backdrop_image`, `released`, `rating`, `genres`, `developers`, `publishers`, ...).
- `POST /api/tmdb/genres` - body `{ media_type: "movie" | "series" }`, returns `[{ id, name }]`.
- `POST /api/kitsu/anime` - anime list/search/detail (structured filters: `id`, `search`, `genre`, `sort` (`popularity`/`rating`/`release`), `sortOrder`, `comingSoon`, `limit`, `offset`). Returns normalized objects (`id: kitsu_<id>`, `media_type: "anime"`, `provider: "kitsu"`, `provider_id`, `name`, `background_image`, `backdrop_image`, `released`, `rating`, `metacritic_score`, `number_of_episodes`, `subtype`, `status`, `genres`, ...).

  List responses collapse an anime franchise into one entry: Kitsu lists every
  season of a show as its own result, so a search for Attack on Titan otherwise
  returns eight near-identical tiles. Only an entry whose title carries a season
  marker is ever folded, and only into a parent present in the same response, so
  nothing is hidden on a guess. The surviving entry carries `franchise_key` and,
  when it absorbed other seasons, `franchise_count`. Everything Kitsu returned
  is still written to the catalog - only the view collapses.

  Pages stay aligned to Kitsu's own offsets rather than being topped back up, so
  no title is skipped or repeated between pages, and an anime page returns fewer
  items than `limit`. Because a short page therefore no longer means "no more
  results", the response carries an `X-Has-More` header (`1`/`0`), exposed to
  the browser through CORS.

  Every anime carries `franchise_key`, and one that read as a sequel also
  carries `franchise_sequel: true` - on folded-away entries too, so a caller
  never has to re-derive the grouping rule for itself. The browse grid uses them
  to drop a sequel whose parent was shown on an earlier page, which the server
  cannot see; the list import uses them to group a MyAnimeList export.

  `collapse: false` returns the list uncollapsed. The import needs it: it is
  matching titles one at a time and has to be able to find the individual
  seasons. Results are also ranked on the catalog title only, never on a title's
  other names - ranking on aliases sounds better and is not, because searching
  "demon slayer" then leads with an obscure show whose alias is exactly that.
  `alt_titles` is on every anime for callers that are matching a known title
  rather than searching, which is the case where an alias is good evidence.
- `POST /api/kitsu/genres` - Kitsu categories, returns `[{ id, name }]`.
- All proxies require a session or run guest-friendly (read-only) and write results through to the shared catalog. TMDB needs `TMDB_ACCESS_TOKEN` (v4) or `TMDB_API_KEY` (v3); **Kitsu needs no key**. When a provider is unconfigured its endpoints return `503`/`500` and the other media types are unaffected.

## Auth

- `Authorization: Bearer <jwt>` **or** httpOnly cookie `mgl_token` (set on login / OAuth complete)
- JWT payload: `{ userId, tv }` (`tv` = `token_version`)
- Sessions: ~7d default, 30d with remember-me
- `GET /api/auth/session` - restore session from httpOnly cookie when localStorage is empty
- Social sign-in (direct, same-origin OAuth2 - first-party cookies):
  - `GET /api/auth/oauth/:provider/start` (`google` | `github`) - sets a signed state cookie and redirects to the provider's consent screen. Optional `?remember=1`.
  - `GET /api/auth/oauth/:provider/callback` - verifies state, exchanges the code, maps identity to a local user (by `provider:sub` or verified email; creates on first sign-in), sets the `mgl_token` cookie, and redirects to `<FRONTEND_URL>/auth.html?oauth=done` (errors → `?oauth_error=...`).
  - `GET /api/auth/public-config` - returns `{ providers: [...] }` (only providers whose client id/secret are configured), so the UI shows the right buttons.
  - Register redirect URIs on each provider: `<FRONTEND_URL>/api/auth/oauth/google/callback` and `<FRONTEND_URL>/api/auth/oauth/github/callback`.
- `POST /api/auth/oauth/complete` - legacy token-based path (`{ access_token, rememberMe? }`); retained for compatibility, superseded by the redirect flow above.
- `PUT /api/auth/username` - claim username after OAuth (auth required)
- `POST /api/auth/logout` - clears cookie (auth optional)
- Same email via Google vs GitHub vs password is **not** auto-merged - see `docs/runbook.md` (Account linking)

## Profiles

Personalisation lives on the user row; the Top 10s and "Currently into" are read
back through the public profile endpoint so a visitor gets them in one request.

- `PUT /api/user/profile` also accepts `bio` (<= 300 chars), `accent`
  (`movie` | `series` | `anime` | `game`, or null), and `banner_style`
  (`posters` | `accent`). Each is only written when present, so an older client
  cannot blank what the user set. `avatar_url` must be an https URL or a PNG,
  JPEG, GIF, or WebP data URI; oversized ones answer 413 rather than saving the
  rest of the profile with the picture dropped.
- `GET /api/user/profile/top` - your Top 10s, grouped by category, in rank order.
- `PUT /api/user/profile/top/:mediaType` - `{ game_ids: [...] }`, the external
  refs in the order you want them, at most 10. Replaces that category outright, so
  adding, removing, and reordering are all the same call. A ref filed under
  another category is rejected.
- `PUT /api/user/profile/current` - `{ game_ids: [...] }`, at most 6, pins which
  in-progress titles show publicly. An empty array clears the pins and the profile
  falls back to the most recently updated in-progress titles.
- `GET /api/users/:userId` additionally returns `top`, `currentlyInto`, and
  `similarity`. All three are `null` when `canView` is false, since each is
  derived from a library that a private account has not shared.

### Similar Taste

`similarity` is `{ percent, shared, coRated, topShared }`, or `null` meaning
"Not enough data yet". It is computed from real rows only: Top 10 agreement
(0.35), rating agreement over co-rated titles (0.30), genre affinity weighted by
score (0.20), and library overlap against the smaller library (0.15). Components
that cannot be measured are dropped and the rest renormalised, then scaled by how
much of the signal was present, so shared saves alone cannot read as high as
shared rankings and scores. See `Backend/taste.js`.

- `GET /api/discover/similar?limit=8` - other people ranked by that percentage.
  Candidates are shortlisted in SQL on shared titles before anything is scored,
  and the scores are cached briefly. Visibility is re-checked on every request, so
  going private removes you from other people's suggestions immediately.

## Social

- `GET /api/following/activity?limit=25` - what the people you follow have been
  doing, newest first. Following is the permission: a private account only gains
  a follower after approving them, so no extra check is needed beyond the join.
  `user_game_lists` is updated in place, so `updated_at` is the event time and
  there is one row per title per person showing its latest state. Planned titles
  are excluded. Each entry carries `status`, `score`, `progress`, and the media.
- `GET /api/users/:userId/compare` - the detail behind the headline percentage:
  `overall`, `categories` (the same score per media type, `percent: null` where
  there is too little shared), `counts`, `commonTop` (in both Top 10s, with both
  ranks), `favourites` (both rated, within 1 point), and `disagreements` (both
  rated, 3 or more apart). 403 for a private account you do not follow, 400 for
  yourself.

## Seasons

Optional, per season ratings for shows and anime. A title with no season rows
behaves exactly as before, so this is additive everywhere.

- `GET /api/user/games/:ref/seasons` - the season list with your entries merged
  in, plus `derived`. The catalog side is filled lazily on first view: TMDB
  returns the whole season list on the series detail response, so listing costs
  one call and no per-season requests. Season 0 (specials) is excluded.
- `PUT /api/user/games/:ref/seasons/:number` - `{ status, score }` using the
  same status vocabulary and the same 1..10 score as the title level. A decimal
  is rounded; anything outside 1..10 is refused rather than clamped.
- `DELETE /api/user/games/:ref/seasons/:number` - clears that season.

The overall is recomputed after every season write and stored on
`user_game_lists.score`, so the library badge, Top 10, stats, and Similar Taste
stay correct without knowing seasons exist. Seasons are weighted by episode
count, only rated seasons count, and the result is rounded to a whole score. With
no season rated the user's own overall is left alone. See `Backend/seasons.js`.

Anime gets there differently, and by two routes. Kitsu models each season as
its own top-level entry rather than a child of one show, so an anime's seasons
are its sibling catalog entries.

1. **By title** - one text search for the franchise, since Kitsu names sequels
   off their parent. `Backend/franchise.js` decides which results really are the
   same franchise. One call, and it answers for most shows.
2. **By the sequel chain** - when the title route finds nothing, walk Kitsu's
   `sequel` and `prequel` relationships. This is what handles a franchise whose
   seasons are named by arc rather than numbered (Demon Slayer's "Yuukaku-hen"),
   and it works from any season, not just the first: it walks back to the head
   before walking forward. It costs one request per hop, so it is the fallback
   rather than the default, runs only when someone opens the panel, and the
   result is cached in `media_seasons` afterwards.

Either way, recaps, shorts and compilation movies are excluded, so a numbered
season is always a real season. Each anime season carries `external_ref`, the
catalog ref of the entry it came from; a show's seasons have `null` there,
because a TMDB season is not a catalog entry in its own right.

## Versioning

- Current mounts: `/api/*`
- Compatibility aliases: `/api/v1/*` (same handlers)
- Prefer `/api/v1` for new external clients; `/api` remains for this app.

See also `docs/openapi.yaml` for the locked IGDB proxy + auth surface.
