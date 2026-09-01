# MediaListory operations runbook

Product stack: **Neon Postgres** + **Neon Auth** (Better Auth). Catalog: **IGDB** (games) + **TMDB** (movies/series). Media discriminated by `games.media_type`.

## Health

| Probe | Meaning |
|-------|---------|
| `GET /health` | Process alive |
| `GET /ready` | Postgres reachable; also reports IGDB env + rate-limit store mode |

If `/ready` is 503, fix `DATABASE_URL` / network / Neon project status before debugging app logic. Neon auto-resumes a suspended project on the next connection.

## Neon backups / branching

1. Neon Console → Project → **Backups / Restore** (point-in-time within the plan's history window).
2. Neon **branches** are cheap copy-on-write clones — branch `production` for a staging/test copy before risky changes.
3. Schema source of truth: `DB/schema.postgres.sql` + ordered files in `DB/README.md` (apply via `neon psql` or the Neon SQL editor).
4. Do **not** restore `DB/legacy/legacy-mysql-igdb.dump.sql` into Postgres.

## Auth notes

Identity is **Neon Auth** (Better Auth). The backend verifies credentials with Neon Auth (email/password via `/sign-in/email`, OAuth via a JWKS-verified JWT) and then mints the app's own JWT (`{ userId, tv }`, HS256) — also set as the httpOnly `mgl_token` cookie. `public.users` (keyed by the Neon Auth user id, also stored in `auth_id`) is the source of truth for username, roles, and ban state. Email/password sign-in is configured with **verification not required**, so register signs the user in immediately.

Manage with the CLI: `neon neon-auth status|config|oauth-provider|domain|user --project-id <id> --branch production`.

### Google (+ Discord) OAuth (Continue with…)

App buttons ask Neon Auth for the provider URL (`POST {NEON_AUTH_BASE_URL}/sign-in/social`), redirect the browser, and on return exchange the Neon Auth session for a JWT (`GET {NEON_AUTH_BASE_URL}/token`) which is posted to `POST /api/auth/oauth/complete`.

1. **Trusted domains** (CSRF): add every app origin, or Neon Auth rejects the calls.
   - `neon neon-auth domain add https://my-game-list-live.vercel.app`
   - `neon neon-auth domain add https://medialistory.onrender.com`
   - `neon neon-auth domain allow-localhost enable` (local dev)
2. **Enable Google:** Neon Console → Auth → providers (a shared dev key is on by default and shows Neon branding; add your own Google OAuth client for production).
3. **Enable Discord:** add it via `neon neon-auth oauth-provider` / the Console with a Discord app's client id + secret (not enabled by default).
4. First OAuth login may show an optional username picker (`PUT /api/auth/username`).
5. **Cross-origin note:** the browser calls the Neon Auth origin with credentials for the token exchange; this relies on the trusted-domain CORS config and third-party cookies. Test the flow in the target browser.

### Account linking (same email, different providers)

Neon Auth (Better Auth) treats each provider identity separately unless linked. Email/password and Google with the same address are distinct users unless account-linking is enabled in the Neon Auth config. Prefer one path per person; to merge manually, export (`GET /api/user/export`), pick a canonical account, re-add. Password reset needs a configured Neon Auth email provider (`neon neon-auth config email-provider`); until then `/api/auth/forgot-password` returns the generic message but sends nothing.

### Sessions (httpOnly cookie + Bearer)

- Login / OAuth complete set `Set-Cookie: mgl_token=…; HttpOnly; SameSite=Lax` (Secure in `NODE_ENV=production`).
- `Authorization: Bearer <jwt>` still works (and is what the SPA stores in `localStorage`).
- Logout: `POST /api/auth/logout` clears the cookie (no auth required). Frontend also clears localStorage.
- Stale JS: after deploy, hard-refresh or clear site data for `localhost` (or use Incognito). API responses use `Cache-Control: no-store`.

### Production deploy checklist

1. Host Node (`npm start`) behind HTTPS; set `NODE_ENV=production`. For **Render API + Vercel Frontend**, see [Split deploy](#split-deploy-render-api--vercel-frontend) below.
2. Add production origins as Neon Auth trusted domains (`neon neon-auth domain add https://my-game-list-live.vercel.app` and the Render origin).
3. Enable the Google (and optionally Discord) OAuth provider in the Neon Console with your own OAuth client for production (the default shared key shows Neon branding).
4. Multi-instance: set `REDIS_URL` so rate limits are shared (in-memory store is single-process only).
5. Smoke: `/health`, `/ready`, register/login, add game, follow.

## Environment / secret rotation

Rotate immediately if a key was pasted into chat, logs, or a public repo:

| Secret | Where | Action |
|--------|-------|--------|
| `JWT_SECRET` | `.env` | Generate new value; all users must re-login |
| `NEON_AUTH_*` | Neon Console → Auth | Rotate/reconfigure via `neon neon-auth`; re-verify sign-in |
| `DATABASE_URL` password | Neon Console → Roles (reset password) | Reset the role password; update the pooled URL |
| `IGDB_CLIENT_SECRET` | Twitch developer console | Rotate secret; clear `IGDB_ACCESS_TOKEN` so app refreshes |

After JWT rotation, bump is automatic (new signatures). After password change for a user, `token_version` invalidates old app JWTs.

## Twitch / IGDB credentials

1. [Twitch developer console](https://dev.twitch.tv/console/apps) → your app.
2. Set `IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET` in `.env`.
3. App fetches an app access token via client credentials (see `Backend/igdb.js`).
4. Optional: set `IGDB_ACCESS_TOKEN` temporarily; prefer secret-based refresh.
5. On 401 from IGDB, restart after rotating the secret; check Twitch app is not disabled.

## TMDB credentials (Movies + Series)

1. [TMDB → Settings → API](https://www.themoviedb.org/settings/api).
2. Set **either** `TMDB_ACCESS_TOKEN` (v4 Read Access Token, preferred) **or** `TMDB_API_KEY` (v3) in `.env`.
3. Movies/series proxies live in `Backend/tmdb.js`; genre lists are cached 24h.
4. If TMDB is unset, `/api/tmdb/*` returns `503`/`500` and the Movies/Series pages show an error — **games are unaffected**.
5. Requires the `add-media-types` DB migration (adds `media_type` + `tmdb_id`); without it, movie/series writes fail.

## Degraded mode

- `ALLOW_DEGRADED=1` - process stays up without DB (local catalog-only checks). **Never in production.**
- IGDB/TMDB outage - list endpoints may return locally cached `games` rows with `X-Cache: DEGRADED`.

## User data export

Authenticated users can download their data:

`GET /api/user/export` (Bearer JWT) → JSON of profile fields, collection, and custom lists.

## Incident checklist

1. Check `/health` and `/ready`.
2. Check Neon project status + Twitch/IGDB + TMDB status.
3. Tail host logs (morgan `combined` in production).
4. Confirm rate-limit store (`memory` vs Redis) if multi-instance.
5. If auth mass-fails after deploy, verify `JWT_SECRET` was not changed unintentionally.

## Split deploy: Render (API) + Vercel (Frontend)

Free-tier layout: **Express API on Render**, **static `Frontend/` on Vercel**. Vercel rewrites `/api/*` (and `/health`, `/ready`) to Render so the SPA can keep `API_BASE = '/api'` (same-origin from the browser). See root [`vercel.json`](../vercel.json).

### Deploy order

1. **Render (API first)**  
   - New **Web Service** from this GitHub repo  
   - Root directory: repo root (`.`)  
   - Build: `npm install` (default)  
   - Start: `npm start`  
   - Env vars from [`.env.example`](../.env.example): `JWT_SECRET`, `DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`, `IGDB_*`, `TMDB_*`, `NODE_ENV=production`  
   - Use the Neon **pooled** `DATABASE_URL` (`...-pooler...neon.tech/neondb?sslmode=require&channel_binding=require`) from the Neon Console → Connect. Keep `DB_SSL_INSECURE=0` (Neon presents a valid cert).  
   - Set `FRONTEND_URL` after Vercel exists (step 3), e.g. `https://your-app.vercel.app`  
   - Note the service URL: `https://YOUR-RENDER-SERVICE.onrender.com`

2. **Wire Vercel → Render**  
   - In [`vercel.json`](../vercel.json), replace every `YOUR-RENDER-SERVICE.onrender.com` with your real Render hostname  
   - Commit and push (or edit in the Vercel UI if you prefer)

3. **Vercel (Frontend)**  
   - Import the same repo → Framework **Other** → Root Directory = project root  
   - No build command required; `vercel.json` serves `/Frontend/*` and proxies `/api`  
   - Deploy → note `https://your-app.vercel.app`  
   - On Render, set `FRONTEND_URL=https://your-app.vercel.app` and restart

4. **Neon Auth trusted domains**  
   - `neon neon-auth domain add https://your-app.vercel.app`  
   - `neon neon-auth domain add https://YOUR-RENDER-SERVICE.onrender.com`  
   - Enable Google/Discord providers in the Neon Console

### Optional: call Render directly (no rewrite)

Set before `common.js` loads:

```html
<script>window.MGL_API_BASE = 'https://YOUR-RENDER-SERVICE.onrender.com/api';</script>
```

Then ensure Render `FRONTEND_URL` matches the Vercel origin (CORS + `credentials: 'include'`). Prefer the rewrite path for simpler cookies.

### Free-tier caveats

- Render sleeps when idle → first `/api` call after wake is slow (Vercel HTML still loads fast).  
- For the simplest demo, hosting **everything on Render** (Express already serves `Frontend/`) avoids two dashboards.
