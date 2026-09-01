# MediaListory

Track what you play and watch, rate your library, and discover with friends — across **Movies**, **Series**, **Anime**, and **Games** in one app. Movie & series data from [TMDB](https://www.themoviedb.org/); anime from [Kitsu](https://kitsu.io/); game data from [IGDB](https://www.igdb.com/) (Twitch).

> Formerly "My Game List" — now expanded from games-only to movies + series + anime + games.

[![Live demo](https://img.shields.io/badge/demo-live-22c55e?style=flat-square)](https://mygamelist-ffyl.onrender.com)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Gr33nOps/MediaListory/ci.yml?branch=main&style=flat-square)](https://github.com/Gr33nOps/MediaListory/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**Live:** [mygamelist-ffyl.onrender.com](https://mygamelist-ffyl.onrender.com)

## Features

- Four separate tabs in one app — **Movies** and **Series** (TMDB), **Anime** (Kitsu), **Games** (IGDB) — each with its own discovery, search, and detail, sharing the same tracking, rating, notes, lists, and profile UI
- Browse and search each category (genre + sort; platform/publisher/developer for games)
- Track status (game "play" / movie, series & anime "watch"), score 1–10, and notes; per-type metadata (episode progress for series & anime); mixed-media custom lists; JSON export
- Library and profiles filter and break down by category
- **Guest mode:** browse, search, and view details without an account; sign in to save
- Email/password auth plus Google & GitHub social sign-in (direct, same-origin OAuth2)
- Follow users and public profiles
- Admin and moderator dashboards

## Stack

Vanilla HTML/CSS/JS frontend, Node/Express API, **Neon Postgres**. Email/password identity via Neon Auth; social sign-in via direct same-origin OAuth2 (Google/GitHub). Content from TMDB (movies/series), Kitsu (anime — no key), and IGDB (games). Deployed on **Render** (serves the full app — frontend + API).

> Migrated off Supabase to Neon. The app mints its own session JWT (httpOnly cookie), so all data/features are unchanged. Social sign-in uses a self-hosted OAuth2 code flow on our own origin, so cookies are first-party.

### Media model

All media lives in one `games` catalog table, discriminated by `media_type` (`movie` | `series` | `anime` | `game`). Every row also records its `provider` (`tmdb` | `kitsu` | `igdb`) and `provider_id`, and `game_id` is the universal external ref (`tmdb_movie_<id>`, `tmdb_series_<id>`, `kitsu_<id>`, `igdb_<id>`). A unique index on `(provider, media_type, provider_id)` guarantees IDs from different providers can never collide. Tracking (`user_game_lists`, incl. `progress` for episodes watched) and custom lists (`custom_list_games`) reference that catalog, so they work for every media type unchanged. Further categories (e.g. books, music) slot in as new `media_type` values without schema churn.

## Quick start

Node.js 18+ required (20 LTS recommended).

```bash
git clone https://github.com/Gr33nOps/MediaListory.git
cd MediaListory
cp .env.example .env
npm install
```

1. Fill `.env` from [`.env.example`](.env.example) (Neon `DATABASE_URL`, Neon Auth, JWT, Twitch/IGDB, TMDB for movies/series; Kitsu needs no key; optional Google/GitHub OAuth). Get the DB string from the Neon Console → Connect; get the auth values from `neon neon-auth status --project-id <id> --branch production`.
2. Apply the schema to Neon: [`DB/schema.postgres.sql`](DB/schema.postgres.sql) + [`DB/migrations/add-media-types.sql`](DB/migrations/add-media-types.sql) + [`DB/migrations/add-auth-id.sql`](DB/migrations/add-auth-id.sql) + [`DB/migrations/add-anime-and-provider.sql`](DB/migrations/add-anime-and-provider.sql) (run via `neon psql` or the Neon SQL editor; see [`DB/README.md`](DB/README.md)).
3. Run:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). You land on browse home; if you are not signed in, the login form appears.

Do not set `ALLOW_DEGRADED=1` in production.

| Command | Description |
|---------|-------------|
| `npm start` | Run the server |
| `npm run dev` | Nodemon reload |
| `npm test` | Unit + smoke tests |

## Deploy

1. **Render** (canonical — serves frontend + API): Web service, `npm start`, env from `.env.example`. Use the Neon **pooled** `DATABASE_URL` (`...-pooler...neon.tech/neondb?sslmode=require&channel_binding=require`), plus `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `JWT_SECRET`, IGDB, TMDB (Kitsu needs no key), and — for social sign-in — `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`. Set `FRONTEND_URL=https://mygamelist-ffyl.onrender.com` (include `https://`).
2. **OAuth apps:** register the redirect URIs on each provider — Google: `https://mygamelist-ffyl.onrender.com/api/auth/oauth/google/callback`; GitHub: `https://mygamelist-ffyl.onrender.com/api/auth/oauth/github/callback`. The flow is same-origin (no external auth domain), so cookies stay first-party.

Details: [`docs/runbook.md`](docs/runbook.md). Probes: `/health` (up), `/ready` (DB + IGDB).

## Maintenance

### Keep-alive

Neon auto-suspends an idle project and **auto-resumes on the next connection**, so no manual "unpause" is needed. [`.github/workflows/keepalive.yml`](.github/workflows/keepalive.yml) runs **Mon/Wed/Fri at 12:00 UTC** (and on demand) and pings the app's `/ready` probe (which runs a query against Neon) to keep the deployed service warm and catch outages early. Override the target with a `READY_URL` repo variable if the API host changes.

### Security scanning (Semgrep)

CI runs a **Semgrep SAST** job ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) on `Backend/` and `Frontend/` that **fails the build on any `WARNING`/`ERROR` finding**. Verified false positives are suppressed inline with justified `nosemgrep` comments. Run it locally with:

```bash
semgrep scan --config p/security-audit --config p/secrets --config p/javascript --config p/nodejs --config p/expressjs --config p/owasp-top-ten --severity WARNING --severity ERROR --error Backend Frontend
```

## Layout

```text
MediaListory/
├── Backend/          Express API (routes + IGDB)
├── Frontend/         Static pages, CSS, JS
├── DB/
│   ├── schema.postgres.sql
│   ├── migrations/   Incremental SQL
│   └── legacy/       Archive + one-time migrator
├── docs/             API notes, OpenAPI, runbook
├── test/             unit / smoke / e2e
└── .github/          CI + issue templates
```

More: [API contracts](docs/API.md) · [OpenAPI](docs/openapi.yaml) · [Runbook](docs/runbook.md)

## License

[MIT](LICENSE) © Gr33nOps
