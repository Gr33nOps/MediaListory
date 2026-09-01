# MediaListory

Track what you play and watch, rate your library, and discover with friends — across **Games**, **Movies**, and **Series** in one app. Game data from [IGDB](https://www.igdb.com/) (Twitch); movie and series data from [TMDB](https://www.themoviedb.org/).

> Formerly "My Game List" — now expanded from games-only to games + movies + series.

[![Live demo](https://img.shields.io/badge/demo-live-22c55e?style=flat-square)](https://mygamelist-ffyl.onrender.com)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/Gr33nOps/MediaListory/ci.yml?branch=main&style=flat-square)](https://github.com/Gr33nOps/MediaListory/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**Live:** [mygamelist-ffyl.onrender.com](https://mygamelist-ffyl.onrender.com)

## Features

- Three categories in one app — **Games** (IGDB), **Movies** and **Series** (TMDB) — sharing the same browse, search, detail, tracking, rating, notes, lists, and profile UI
- Browse and search each category (genre + sort; platform/publisher/developer for games)
- Track status (game "play" / movie & series "watch"), score 1–10, and notes; mixed-media custom lists; JSON export
- Library and profiles filter and break down by category
- **Guest mode:** browse, search, and view details without an account; sign in to save
- Email/password auth (Neon Auth) plus Google & GitHub social sign-in
- Follow users and public profiles
- Admin and moderator dashboards

## Stack

Vanilla HTML/CSS/JS frontend, Node/Express API, **Neon Postgres** + **Neon Auth** (Better Auth: email/password + Google/GitHub OAuth), IGDB (games) + TMDB (movies/series). Deployed on **Render** (serves the full app — frontend + API).

> Migrated off Supabase to Neon. The app mints its own session JWT after verifying identity with Neon Auth, so all data/features are unchanged; only the identity provider swapped.

### Media model

All media lives in one `games` catalog table, discriminated by `media_type` (`game` | `movie` | `series`). `game_id` is the universal external ref (`igdb_<id>`, `tmdb_movie_<id>`, `tmdb_series_<id>`). Tracking (`user_game_lists`) and custom lists (`custom_list_games`) reference that catalog, so they work for every media type unchanged. Future categories (e.g. anime, books, music) slot in as new `media_type` values without schema churn.

## Quick start

Node.js 18+ required (20 LTS recommended).

```bash
git clone https://github.com/Gr33nOps/MediaListory.git
cd MediaListory
cp .env.example .env
npm install
```

1. Fill `.env` from [`.env.example`](.env.example) (Neon `DATABASE_URL`, Neon Auth, JWT, Twitch/IGDB, and TMDB for movies/series). Get the DB string from the Neon Console → Connect; get the auth values from `neon neon-auth status --project-id <id> --branch production`.
2. Apply the schema to Neon: [`DB/schema.postgres.sql`](DB/schema.postgres.sql) + [`DB/migrations/add-media-types.sql`](DB/migrations/add-media-types.sql) + [`DB/migrations/add-auth-id.sql`](DB/migrations/add-auth-id.sql) (run via `neon psql` or the Neon SQL editor; see [`DB/README.md`](DB/README.md)).
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

1. **Render:** Web service, `npm start`, env from `.env.example`. Use the Neon **pooled** `DATABASE_URL` (`...-pooler...neon.tech/neondb?sslmode=require&channel_binding=require`), plus `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `JWT_SECRET`, IGDB, TMDB. Set `FRONTEND_URL=https://mygamelist-ffyl.onrender.com` (include `https://`).
2. **Vercel:** Import the repo. [`vercel.json`](vercel.json) rewrites `/api`, `/health`, `/ready` to Render and serves `Frontend/`.
3. **Neon Auth:** add your Vercel and Render origins as trusted domains (`neon neon-auth domain add <url>`), and enable the Google (and optionally Discord) OAuth providers in the Neon Console.

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
