# Database

Canonical schema and incremental migrations for Supabase Postgres. One `games`
catalog table holds all media, discriminated by `media_type` (`game`/`movie`/`series`);
games come from IGDB, movies/series from TMDB.

## Layout

```text
DB/
  schema.postgres.sql   # apply this for a new environment
  migrations/           # incremental SQL (already applied on live)
  legacy/               # MySQL dump + one-time data migrator (do not run on Postgres)
  README.md
```

## Apply

1. New project: run [`schema.postgres.sql`](schema.postgres.sql) in the Supabase SQL editor.
2. Existing project: apply any pending files under [`migrations/`](migrations/) in order if needed.

| File | Purpose |
|------|---------|
| `migrations/add-token-version.sql` | JWT `token_version` column |
| `migrations/add-username-lower-unique.sql` | Case-insensitive unique username |
| `migrations/add-scale-indexes.sql` | Follow / activity indexes |
| `migrations/add-notes-column.sql` | `user_game_lists.notes` for export |
| `migrations/add-media-types.sql` | `games.media_type` + `games.tmdb_id` for movies/series (**required** for MediaListory; additive, existing rows become `media_type='game'`) |
| `legacy/legacy-mysql-igdb.dump.sql` | Archive only. Do not apply to Postgres |
| `legacy/migrate_data.js` | One-time MySQL to Supabase data copy |

**Live project `hhcoxrvubiruwkcavtta`:** migrations were applied (July 2026), plus security hardening for SECURITY DEFINER grants and `pg_trgm` under `extensions`.

Leaked-password protection needs Supabase Pro+; the Free-plan advisor warning for that is expected.
