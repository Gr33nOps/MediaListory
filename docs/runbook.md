# MyGameList operations runbook

Product stack: **IGDB (Twitch) only** - not RAWG. Schema column is `igdb_id`.

## Health

| Probe | Meaning |
|-------|---------|
| `GET /health` | Process alive |
| `GET /ready` | Postgres reachable; also reports IGDB env + rate-limit store mode |

If `/ready` is 503, fix `DATABASE_URL` / network / Supabase status before debugging app logic.

## Supabase backups / PITR

1. Supabase Dashboard → Project → **Database** → Backups.
2. Enable **Point-in-time recovery** on paid plans when you care about production data.
3. Practice a restore into a **staging** project before you need it.
4. Schema source of truth: `DB/schema.postgres.sql` + ordered files in `DB/README.md`.
5. Do **not** restore `DB/legacy/legacy-mysql-igdb.dump.sql` into Postgres.

## Auth notes

- **Leaked password protection** (Have I Been Pwned) is a Supabase **Pro Plan and above** Auth setting. On Free, the security advisor warning is expected and can be ignored until you upgrade: [password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

### Google + Discord OAuth (Continue with…)

App buttons call Supabase Auth, then `POST /api/auth/oauth/complete` mints the app JWT (also sets httpOnly `mgl_token` cookie; Bearer in `localStorage` remains supported).

1. **Supabase → Authentication → URL configuration** (production first)
   - **Site URL:** `https://my-game-list-live.vercel.app`  
     (If this stays `http://localhost:3000`, Google/Discord login sends users to localhost after auth.)
   - **Redirect URLs** (add all of these):
     - `https://my-game-list-live.vercel.app/auth.html`
     - `https://my-game-list-live.vercel.app/**`
     - `http://localhost:3000/auth.html` (local dev only)
     - `http://localhost:3000/**`
2. **Enable Google**
   - [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth client (Web)
   - Authorized redirect URI: `https://<PROJECT_REF>.supabase.co/auth/v1/callback`
   - Supabase → Authentication → Providers → Google → Client ID + Secret
3. **Enable Discord**
   - [Discord Developer Portal](https://discord.com/developers/applications) → OAuth2
   - Redirects: `https://<PROJECT_REF>.supabase.co/auth/v1/callback`
   - Supabase → Authentication → Providers → Discord → Client ID + Secret
4. Restart the Node server after env is set; no extra env vars are required beyond existing Supabase keys.
5. **First OAuth login** may show an optional username picker (`PUT /api/auth/username`). Skipping keeps the auto-generated username.
6. **Google consent → Production** (when non-test users should sign in):
   - [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → **OAuth consent screen**
   - Click **Publish app** (moves from Testing → Production)
   - If Google asks for verification, you can still use the app with an unverified warning until you complete verification (fine for demos/small audiences)
   - Until published, only **test users** listed on that screen can complete Google sign-in

### Account linking (same email, different providers)

Supabase Auth treats Google, Discord, and email/password as separate identities unless they are linked on the same Auth user.

- Signing in with Google using `you@gmail.com` and later registering password auth with the same email can create **two users** (or fail with “already registered”), depending on Supabase provider settings.
- Prefer one path per person: OAuth **or** password. If a user already has password auth, use that; do not assume Google/Discord auto-merges collections.
- To merge manually today: export data (`GET /api/user/export`), pick a canonical account, re-add games / re-follow as needed. Automatic identity merge is not implemented.
- Operators: check Supabase → Authentication → Users for duplicate emails / identities before promoting admins.

### Sessions (httpOnly cookie + Bearer)

- Login / OAuth complete set `Set-Cookie: mgl_token=…; HttpOnly; SameSite=Lax` (Secure in `NODE_ENV=production`).
- `Authorization: Bearer <jwt>` still works (and is what the SPA stores in `localStorage`).
- Logout: `POST /api/auth/logout` clears the cookie (no auth required). Frontend also clears localStorage.
- Stale JS: after deploy, hard-refresh or clear site data for `localhost` (or use Incognito). API responses use `Cache-Control: no-store`.

### Production deploy checklist

1. Host Node (`npm start`) behind HTTPS; set `NODE_ENV=production`. For **Render API + Vercel Frontend**, see [Split deploy](#split-deploy-render-api--vercel-frontend) below.
2. Add production Site URL + redirect URLs in Supabase Auth:
   - Site URL = `https://my-game-list-live.vercel.app`
   - Redirect URLs include `https://my-game-list-live.vercel.app/auth.html`
3. Add the same origin to Google OAuth client authorized JavaScript origins / Discord redirects as needed (Supabase callback URL stays `https://<PROJECT_REF>.supabase.co/auth/v1/callback`).
4. Multi-instance: set `REDIS_URL` so rate limits are shared (in-memory store is single-process only).
5. Smoke: `/health`, `/ready`, register/login, add game, follow.

## Environment / secret rotation

Rotate immediately if a key was pasted into chat, logs, or a public repo:

| Secret | Where | Action |
|--------|-------|--------|
| `JWT_SECRET` | `.env` | Generate new value; all users must re-login |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | Roll key; update `.env` / host secrets |
| `SUPABASE_ANON_KEY` | same | Roll if leaked |
| `DATABASE_URL` password | Supabase → Database | Reset DB password; update URL |
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
2. Check Supabase status + Twitch/IGDB status.
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
   - Env vars from [`.env.example`](../.env.example): `JWT_SECRET`, `SUPABASE_*`, `DATABASE_URL`, `IGDB_*`, `NODE_ENV=production`  
   - **Important - IPv4:** Render cannot reach Supabase’s direct `db.*.supabase.co` host (IPv6 → `ENETUNREACH`).  
     Set `DATABASE_URL` to the **Session pooler** string from Supabase → **Connect** → **Connection pooling**  
     (host like `aws-0-` / `aws-1-<region>.pooler.supabase.com` - copy exact host from the dashboard;
     user `postgres.<project-ref>`, port `5432`). Wrong cluster → `tenant/user not found`.  
     Also set `DB_SSL_INSECURE=1` if TLS verify fails.  
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

4. **Supabase Auth URLs**  
   - Site URL: `https://your-app.vercel.app`  
   - Redirect URLs include: `https://your-app.vercel.app/auth.html`  
   - Google/Discord provider callback stays `https://<PROJECT_REF>.supabase.co/auth/v1/callback` (unchanged)

### Optional: call Render directly (no rewrite)

Set before `common.js` loads:

```html
<script>window.MGL_API_BASE = 'https://YOUR-RENDER-SERVICE.onrender.com/api';</script>
```

Then ensure Render `FRONTEND_URL` matches the Vercel origin (CORS + `credentials: 'include'`). Prefer the rewrite path for simpler cookies.

### Free-tier caveats

- Render sleeps when idle → first `/api` call after wake is slow (Vercel HTML still loads fast).  
- For the simplest demo, hosting **everything on Render** (Express already serves `Frontend/`) avoids two dashboards.
